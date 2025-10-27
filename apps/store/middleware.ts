// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** 認証不要の公開パス */
function isPublicPath(pathname: string) {
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth/") || // 認証系 API は公開
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/static/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/healthz"
  ) {
    return true;
  }
  // 拡張子で静的ファイルを除外
  if (/\.(ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|map)$/i.test(pathname)) {
    return true;
  }
  return false;
}

/** サーバ側のセッション検査（401 は未ログイン扱い） */
async function inspectSession(
  req: NextRequest
): Promise<{ ok: boolean; store_id: string | null }> {
  try {
    const url = new URL("/api/auth/session/inspect", req.url);
    const res = await fetch(url, {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, store_id: null };
    const j = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      store_id?: string | null;
    };
    return { ok: !!j?.ok, store_id: j?.store_id ?? null };
  } catch {
    return { ok: false, store_id: null };
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;

  // 1) 公開パスは素通し
  if (isPublicPath(pathname)) return NextResponse.next();

  // 2) API ルートの扱い（認証系は公開、その他はログイン必須）
  if (pathname.startsWith("/api/")) {
    // CORS プリフライトは常に許可
    if (req.method === "OPTIONS") return NextResponse.next();
    // 認証系 API は公開
    if (pathname.startsWith("/api/auth/")) return NextResponse.next();

    const session = await inspectSession(req);
    if (!session.ok) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // 3) ページ（/analytics を含む全ページ）
  const session = await inspectSession(req);

  // フォールバック: inspect が空でも store_selected クッキーがあれば採用
  const cookieSelected = req.cookies.get("store_selected")?.value || null;
  const effectiveStoreId = session.store_id ?? cookieSelected;

  // 未ログイン → /login
  if (!session.ok) {
    if (req.method === "GET" || req.method === "HEAD") {
      const loginUrl = new URL("/login", origin);
      // loginUrl.searchParams.set("next", pathname + search); // 必要なら復帰先を保持
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  // 既に選択済みなのに /select-store にいる場合はホームへ（保険）
  if (pathname.startsWith("/select-store") && effectiveStoreId) {
    if (req.method === "GET" || req.method === "HEAD") {
      return NextResponse.redirect(new URL("/", origin));
    }
    return NextResponse.json({ ok: true }, { status: 204 });
  }

  // ログイン済み・店舗未選択 → /select-store（/analytics も含め保護）
  if (!effectiveStoreId && !pathname.startsWith("/select-store")) {
    if (req.method === "GET" || req.method === "HEAD") {
      return NextResponse.redirect(new URL("/select-store", origin));
    }
    return NextResponse.json(
      { ok: false, error: "STORE_NOT_SELECTED" },
      { status: 401 }
    );
  }

  // 通過
  return NextResponse.next();
}

/** すべてのパスに適用（公開パスは本文で除外） */
export const config = { matcher: ["/:path*"] };
