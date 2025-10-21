// apps/user/next.config.ts
import type { NextConfig } from "next";

const isProd =
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production";

// 本番では vercel.live を許可しない（Preview/Dev のみ許可）
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "https://js.stripe.com",
  "https://*.stripe.com",
  "https://static.line-scdn.net",
  "https://liff.line.me",
  ...(isProd ? [] : ["https://vercel.live"]),
];

// ★ ここが今回の修正ポイント：img-src を広げる
// - data: / blob: はそのまま
// - Supabase Storage（https://*.supabase.co）や Google/LH（OAuthアバター）等も拾えるように
// - 最短で復旧したいので一旦 https://* を許可（必要になったら徐々に絞る）
const imgSrc = ["'self'", "data:", "blob:", "https://*"].join(" ");

const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc.join(" ")}`,
  `script-src-elem ${scriptSrc.join(" ")}`,
  "script-src-attr 'self' 'unsafe-inline'",
  // ← 修正済み
  `img-src ${imgSrc}`,
  "style-src 'self' 'unsafe-inline'",
  // Stripe の Web フォントを許可（'none' は使わない）
  "font-src 'self' data: https://js.stripe.com https://*.stripe.com",
  // LIFF / Stripe / Supabase など
  "connect-src 'self' ws: wss: https://api.line.me https://js.stripe.com https://m.stripe.com https://q.stripe.com https://r.stripe.com https://*.stripe.com https://dsrueuqshqdtkrprcjmc.supabase.co wss://dsrueuqshqdtkrprcjmc.supabase.co https://*.supabase.co wss://*.supabase.co",
  // Google マップ埋め込み（iframe）を許可
  "frame-src 'self' https://js.stripe.com https://*.stripe.com https://*.line.me https://liff.line.me https://www.google.com https://maps.google.com https://*.google.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
