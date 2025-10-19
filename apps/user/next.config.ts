// apps/user/next.config.ts  /  apps/store/next.config.ts
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// 必要ドメインをすべて列挙（あなたの Supabase プロジェクトホスト名）
const SUPABASE_HOST = "dsrueuqshqdtkrprcjmc.supabase.co"; // ←そのままでOK（あなたのログのホスト）

function buildCSP() {
  // 注意: 1行文字列で返す（改行しない）
  const parts = [
    "default-src 'self'",
    "base-uri 'self'",
    // dev だけ 'unsafe-eval' を許可（Next/webpack HMR 用）
    `script-src 'self' 'unsafe-inline' ${
      isDev ? "'unsafe-eval' " : ""
    }https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline' https://js.stripe.com",
    // 画像: self/data/blob + Stripe + Supabase（公開バケット等）
    `img-src 'self' data: blob: https://*.stripe.com https://${SUPABASE_HOST}`,
    // フォント: Stripe配布フォント + data:（一部が data: で来る場合用）
    "font-src 'self' https://js.stripe.com data:",
    // 接続先: HMR(ws/wss) + Stripe計測 + Supabase REST/Realtime（https と wss）
    `connect-src 'self' ws: wss: https://api.stripe.com https://m.stripe.com https://q.stripe.com https://r.stripe.com https://*.stripe.com https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
    // 埋め込み: Stripe
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "form-action 'self' https://*.stripe.com",
    "upgrade-insecure-requests",
  ];
  return parts.join("; ");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildCSP(),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
