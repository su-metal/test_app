// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** store_session が無ければ未ログイン扱い（値が 'undefined' なども弾く） */
function isUnauthed(req: NextRequest) {
  const v = req.cookies.get("store_session")?.value ?? "";
  return !v || v === "undefined" || v.length < 16;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // API（認証API以外）は未ログインなら 401 JSON
  if (pathname.startsWith("/api/")) {
    if (isUnauthed(req)) {
      return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return NextResponse.next();
  }

  // ページは未ログインなら /login へ 302
  if (isUnauthed(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * matcher を正規表現で指定し、公開パスはここで除外する。
 * - /login
 * - /api/auth/*
 * - Next.js 静的配信系 (_next/static, _next/image)
 * - favicon / assets / robots / sitemap
 * それ以外の全パス（トップ `/` を含む）に適用。
 */
export const config = { matcher: ["/:path*"] };
