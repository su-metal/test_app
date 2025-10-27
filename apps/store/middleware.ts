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
  if (/\.(ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|map)$/i.test(pathname)) {
    return true;
  }
  return false;
}

/** サーバ側でセッション検査（未ログイン/ログイン済み/店舗未選択を厳密判定） */
async function inspectSession(
  req: NextRequest
): Promise<{ ok: boolean; store_id: string | null }> {
  try {
    const url = new URL("/api/auth/session/inspect", req.url);
    const res = await fetch(url, {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, store_id: null }; // 401 などは未ログイン扱い
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

  // 公開パスは素通し
  if (isPublicPath(pathname)) return NextResponse.next();

  // API
  if (pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") return NextResponse.next(); // CORSプリフライト
    const session = await inspectSession(req);
    if (!session.ok) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // ページ（/ を含む）
  const session = await inspectSession(req);

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

  // ログイン済み・店舗未選択 → /select-store（※ 既にそこなら通過）
  if (!session.store_id && !pathname.startsWith("/select-store")) {
    if (req.method === "GET" || req.method === "HEAD") {
      return NextResponse.redirect(new URL("/select-store", origin));
    }
    return NextResponse.json(
      { ok: false, error: "STORE_NOT_SELECTED" },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = { matcher: ["/:path*"] };
