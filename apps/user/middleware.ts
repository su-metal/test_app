// middleware.ts  ← この1ファイルをコピペで追加（apps/user と apps/store の両方に置く）
// 既存の next.config.ts を変更せずに、レスポンスヘッダでCSPを配布します。

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const config = {
  // 全ルートに適用（必要に応じて絞り込んでOK）
  matcher: "/:path*",
};

export default function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const isProd =
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production";

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://js.stripe.com",
    "https://static.line-scdn.net",
    "https://liff.line.me",
  ];

  // 本番では Vercel Live を許可しない（プレビュー/開発のみ許可）
  if (!isProd) {
    scriptSrc.push("https://vercel.live");
  }

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "img-src 'self' data: blob: https://*.stripe.com https://static.line-scdn.net",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data: https://js.stripe.com https://*.stripe.com",
    "connect-src 'self' ws: wss: https://api.line.me https://js.stripe.com https://m.stripe.com https://q.stripe.com https://r.stripe.com https://*.stripe.com https://dsrueuqshqdtkrprcjmc.supabase.co wss://dsrueuqshqdtkrprcjmc.supabase.co https://*.supabase.co wss://*.supabase.co",
    // Google マップ埋め込み（iframe）を許可
    "frame-src 'self' https://js.stripe.com https://*.stripe.com https://*.line.me https://liff.line.me https://www.google.com https://maps.google.com https://*.google.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
  ].join("; ");

  // 既存ヘッダは保持しつつ、必要ヘッダを上書き/追加
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");

  return res;
}
