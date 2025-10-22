// apps/store/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * 認証判定（副作用なし・Cookieのみ）
 * - SupabaseのCookieは環境により sb-access-token / sb-access-token-<project> など可変
 * - 将来の変更にも強いように前方一致で検出
 */
function hasSupabaseSession(req: NextRequest): boolean {
  const cookies = req.cookies;
  // 最低限の2種類（access/refresh）のどちらかがあれば「一旦ログイン済み」とみなす
  const hasAccess = cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-access-token"));
  const hasRefresh = cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-refresh-token"));
  return hasAccess || hasRefresh;
}

/**
 * 認証不要のパス（ホワイトリスト）
 * - ここに列挙されたものは middleware の対象外（副作用を避ける）
 */
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api", // APIは認証方式が別のことが多いので除外
  "/_next", // Next.js静的アセット
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/assets",
  "/images",
  "/static",
  "/fonts",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

export function middleware(req: NextRequest) {
  const { pathname, search } = new URL(req.url);

  // 1) 事前除外：プリフライト / 公開パス は素通し（副作用ゼロ）
  if (req.method === "OPTIONS" || isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 2) 認証チェック
  if (!hasSupabaseSession(req)) {
    // 元の行き先を next= に保存して /login へ
    const loginUrl = new URL("/login", req.url);
    if (pathname !== "/login") {
      const next = pathname + (search || "");
      loginUrl.searchParams.set("next", next);
    }
    return NextResponse.redirect(loginUrl);
  }

  // 3) 認証OKならそのまま
  return NextResponse.next();
}

/**
 * matcher は「保護したいURL集合」に対して広めに適用しつつ、
 * 主要な静的配下は除外する正規表現を使用
 */
export const config = {
  matcher: [
    // 例: /api, /_next, /favicon.ico などは除外
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|assets|images|static|fonts|manifest.webmanifest).*)",
  ],
};
