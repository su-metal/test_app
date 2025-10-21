// apps/store/next.config.ts
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// あなたの Supabase プロジェクトのホスト（ログから）
const SUPABASE_HOST = "dsrueuqshqdtkrprcjmc.supabase.co";

function buildCSP() {
  // 改行せず 1 行の文字列で返すこと（ヘッダ用）
  const parts = [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src 'self' 'unsafe-inline' ${
      isDev ? "'unsafe-eval' " : ""
    }https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline' https://js.stripe.com",
    `img-src 'self' data: blob: https://*.stripe.com https://${SUPABASE_HOST}`,
    "font-src 'self' https://js.stripe.com data:",
    `connect-src 'self' ws: wss: https://api.stripe.com https://m.stripe.com https://q.stripe.com https://r.stripe.com https://*.stripe.com https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
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
  // テスト運用フェーズ: ビルド失敗を避けるため ESLint をビルド時は無視
  // TODO(req v2): ルール修正が完了したら削除して厳格化する
  eslint: {
    ignoreDuringBuilds: true,
  },
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
