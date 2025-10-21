import { NextResponse } from "next/server";

// OSRM プロキシ: LIFF 環境の CSP で外部直アクセスが拒否されるため
// クライアントからは同一オリジンの本 API を叩く
// 入力: GET /api/osrm?profile=walking|driving&origin=lat,lng&dest=lat,lng
// 返却: OSRM API の JSON をそのまま返却

const DEFAULT_BASE = "https://router.project-osrm.org";

function parseLatLng(v: string | null): { lat: number; lng: number } | null {
  if (!v) return null;
  const m = v.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const profileRaw = url.searchParams.get("profile") || "walking";
  const origin = parseLatLng(url.searchParams.get("origin"));
  const dest = parseLatLng(url.searchParams.get("dest"));

  // walking -> foot にマップ（OSRM の profile 名）
  const profile = profileRaw === "driving" ? "driving" : "foot";

  if (!origin || !dest) {
    return NextResponse.json(
      { error: "origin/dest を 'lat,lng' 形式で指定してください" },
      { status: 400 }
    );
  }

  // 既定のクエリ最小化（CSP 都合でレスポンス小さめ）
  const overview = url.searchParams.get("overview") ?? "false";
  const alternatives = url.searchParams.get("alternatives") ?? "false";
  const steps = url.searchParams.get("steps") ?? "false";

  const base = process.env.OSRM_BASE_URL || DEFAULT_BASE;
  const osrmUrl = `${base}/route/v1/${profile}/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=${overview}&alternatives=${alternatives}&steps=${steps}`;

  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(osrmUrl, {
      // 短期キャッシュ（CDN/Proxy）: 5分
      // TODO(req v2): キャッシュ戦略の最終化
      headers: { "Accept": "application/json" },
      signal: controller.signal,
      // Next.js へのヒント
      cache: "no-store",
      // @ts-expect-error next runtime hint (optional)
      next: { revalidate: 0 },
    }).finally(() => clearTimeout(to));

    const txt = await res.text();
    if (!res.ok) {
      return new NextResponse(txt || "", {
        status: res.status,
        headers: { "Content-Type": res.headers.get("content-type") || "text/plain" },
      });
    }
    return new NextResponse(txt, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/json",
        // CDN 向け
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=300",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: "OSRM リクエストに失敗しました" }, { status: 504 });
  }
}

