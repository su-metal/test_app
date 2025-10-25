// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * ログイン不要で通すパス（/login, 認証API, 静的アセット等）
 * ここに列挙されたものは保護しません。
 */
const isPublicPath = (pathname: string) =>
  pathname.startsWith("/login") ||
  pathname.startsWith("/api/auth/") ||
  pathname.startsWith("/_next/") ||
  pathname.startsWith("/favicon") ||
  pathname.startsWith("/assets") ||
  pathname === "/robots.txt" ||
  pathname === "/sitemap.xml";

/** 未ログイン（store_session が無い/明らかに不正）なら true */
function isUnauthed(req: NextRequest) {
  const cookie = req.cookies.get("store_session")?.value ?? "";
  return !cookie || cookie.length < 16;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 公開パスはそのまま通す
  if (isPublicPath(pathname)) return NextResponse.next();

  const unauthed = isUnauthed(req);

  // API は 401 JSON を返す（/api/auth/* は isPublicPath で除外済み）
  if (pathname.startsWith("/api/")) {
    if (unauthed) {
      return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return NextResponse.next();
  }

  // ページは /login へリダイレクト
  if (unauthed) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = ""; // クエリを残したい場合はここで調整
    return NextResponse.redirect(url);
  }

  // 認証済みはそのまま
  return NextResponse.next();
}

/**
 * 重要: トップ(`/`)を含む全パスに適用。
 * 除外は isPublicPath 側で制御します。
 */
export const config = {
  matcher: ["/:path*"],
};
