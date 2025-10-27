// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** 認証不要の公開パス */
function isPublicPath(pathname: string) {
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth/") || // 認証系APIは公開
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

/** セッション検査（未ログイン/ログイン済み/店舗未選択を厳密判定） */
async function inspectSession(
  req: NextRequest
): Promise<{ ok: boolean; store_id: string | null }> {
  try {
    const url = new URL("/api/auth/session/inspect", req.url);
    const res = await fetch(url, {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, store_id: null }; // 401等は未ログイン扱い
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      store_id?: string | null;
    };
    return { ok: !!data?.ok, store_id: data?.store_id ?? null };
  } catch {
    return { ok: false, store_id: null };
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;

  // 1) 公開パスは素通し
  if (isPublicPath(pathname)) return NextResponse.next();

  // 2) API の扱い
  if (pathname.startsWith("/api/")) {
    // CORSプリフライトは常に許可
    if (req.method === "OPTIONS") return NextResponse.next();

    // 認証系APIは公開（/api/auth/* は通す）
    if (pathname.startsWith("/api/auth/")) return NextResponse.next();

    // それ以外のAPIは未ログインなら401
    const session = await inspectSession(req);
    if (!session.ok) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // 3) 通常ページ（/ を含む）
  const session = await inspectSession(req);

  // ★ フォールバック: store_selected クッキーを採用
  const cookieSelected = req.cookies.get("store_selected")?.value || null;
  const effectiveStoreId = session.store_id ?? cookieSelected;

  // 未ログイン → 必ず /login
  if (!session.ok) {
    if (req.method === "GET" || req.method === "HEAD") {
      const loginUrl = new URL("/login", origin);
      // loginUrl.searchParams.set("next", pathname + search); // 任意
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  // ★ 保険: 既に store が選ばれているのに /select-store に居る → ホームへ戻す
  if (pathname.startsWith("/select-store") && effectiveStoreId) {
    if (req.method === "GET" || req.method === "HEAD") {
      return NextResponse.redirect(new URL("/", origin));
    }
    return NextResponse.json({ ok: true }, { status: 204 });
  }

  // ログイン済み・店舗未選択 → /select-store（※ 既にそこなら素通し）
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
