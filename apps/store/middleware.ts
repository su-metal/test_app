// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** store_session が無ければ未ログイン扱い（値が 'undefined' なども弾く） */
function isUnauthed(req: NextRequest) {
  const v = req.cookies.get("store_session")?.value ?? "";
  return !v || v === "undefined" || v.length < 16;
}

/** 静的アセットや Next 内部パス、ヘルスチェックを除外 */
function isPublicPath(pathname: string) {
  if (
    pathname.startsWith("/login") ||
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

export function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;

  // 1) 公開パスは素通し
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 2) API ルート
  if (pathname.startsWith("/api/")) {
    // 2-1) CORS プリフライトは常に許可
    if (req.method === "OPTIONS") {
      return NextResponse.next();
    }
    // 2-2) 認証系 API は公開
    if (pathname.startsWith("/api/auth/")) {
      return NextResponse.next();
    }
    // 2-3) それ以外の API は未ログインなら 401 JSON
    if (isUnauthed(req)) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // 3) 通常ページ（トップ `/` を含む）
  if (isUnauthed(req)) {
    // GET/HEAD のみ 302 リダイレクト。それ以外は 401 を返す（副作用回避）
    if (req.method === "GET" || req.method === "HEAD") {
      const loginUrl = new URL("/login", origin);
      // 元の訪問先を保持したい場合は next を付与（任意）
      // loginUrl.searchParams.set("next", pathname + search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

/**
 * 全パス対象にしつつ、公開パスは本文で除外。
 * これにより `/` を含む全ページで未ログイン時は /login へ 302（GET/HEAD）。
 */
export const config = {
  matcher: ["/:path*"],
};
