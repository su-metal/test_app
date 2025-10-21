import { NextResponse } from "next/server";

// 地図フォールバック用の静的画像を返す API
// 既定は OpenStreetMap の staticmap サービスをプロキシ
// 例: /api/maps-static?lat=35.0&lng=135.0&zoom=15&size=600x400

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const zoom = clamp(Number(url.searchParams.get("zoom") ?? 15), 3, 19);
  const size = (url.searchParams.get("size") || "640x400").match(/^(\d{2,4})x(\d{2,4})$/);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat/lng を指定してください" }, { status: 400 });
  }

  const w = size ? Number(size[1]) : 640;
  const h = size ? Number(size[2]) : 400;

  // OSM staticmap（鍵不要）
  const osm = new URL("https://staticmap.openstreetmap.de/staticmap.php");
  osm.searchParams.set("center", `${lat},${lng}`);
  osm.searchParams.set("zoom", String(zoom));
  osm.searchParams.set("size", `${w}x${h}`);
  osm.searchParams.set("markers", `${lat},${lng},red-pushpin`);

  try {
    const res = await fetch(osm.toString(), {
      // 軽めにキャッシュ（CDN）
      // TODO(req v2): タイルキャッシュ方針の最終化
      cache: "force-cache",
      // @ts-expect-error next hint (optional)
      next: { revalidate: 1800 },
    });
    const buf = await res.arrayBuffer();
    return new NextResponse(Buffer.from(buf), {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") || "image/png",
        "Cache-Control": "public, max-age=0, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "地図画像の取得に失敗しました" }, { status: 502 });
  }
}

