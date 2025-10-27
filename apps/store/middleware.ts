// apps/store/src/middleware.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** 公開パス（認証不要） */
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

/** サーバ側でセッションを検査（未ログイン/ログイン済み/店舗未選択を厳密判定） */
async function inspectSession(req: NextRequest): Promise<{
  ok: boolean;
  store_id: string | null;
}> {
  try {
    const url = new URL("/api/auth/session/inspect", req.url);
    const res = await fetch(url, {
      headers: {
        cookie: req.headers.get("cookie") ?? "",
      },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, store_id: null };
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      store_id?: string | null;
    };
    return { ok: !!data?.ok, store_id: data?.store_id ?? null };
  } catch {
    // 検査APIに到達できない場合は安全側に倒して「未ログイン」とみなす
    return { ok: false, store_id: null };
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;

  // 1) 公開パスは素通し
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 2) API ルートの扱い
  if (pathname.startsWith("/api/")) {
    // CORS プリフライトは常に許可
    if (req.method === "OPTIONS") {
      return NextResponse.next();
    }
    // 認証チェック（auth 系は上で素通し済み）
    const session = await inspectSession(req);
    if (!session.ok) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // 3) 通常ページ（トップ `/` を含む）
  const session = await inspectSession(req);

  // 未ログイン → 必ず /login へ
  if (!session.ok) {
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

  // ログイン済みだが store 未選択 → /select-store へ（既にそこなら素通し）
  if (!session.store_id && !pathname.startsWith("/select-store")) {
    if (req.method === "GET" || req.method === "HEAD") {
      return NextResponse.redirect(new URL("/select-store", origin));
    }
    return NextResponse.json(
      { ok: false, error: "STORE_NOT_SELECTED" },
      { status: 401 }
    );
  }

  // ログイン済み & store 選択済み → 通過
  return NextResponse.next();
}

/** すべてのパスに適用し、公開パスは本文で除外 */
export const config = {
  matcher: ["/:path*"],
};
