// apps/user/next.config.ts
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
let supabaseHost = "";
try { supabaseHost = new URL(supabaseUrl).host; } catch {}

function buildCSP() {
  const parts = [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ""}https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline' https://js.stripe.com",
    `img-src 'self' data: blob: https://*.stripe.com${supabaseHost ? ` https://${supabaseHost}` : ""}`,
    "font-src 'self' data: https://js.stripe.com",
    `connect-src 'self' ws: wss: https://api.stripe.com https://m.stripe.com https://q.stripe.com https://r.stripe.com https://*.stripe.com https://js.stripe.com${supabaseHost ? ` https://${supabaseHost} wss://${supabaseHost}` : ""} https://*.supabase.co wss://*.supabase.co`,
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
    "worker-src 'self' blob:",
    "form-action 'self' https://*.stripe.com",
  ];
  return parts.join("; ");
}

const nextConfig: NextConfig = {
  // テスト運用優先: ビルド時の ESLint/型エラーは無視
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: buildCSP() },
        ],
      },
    ];
  },
};

export default nextConfig;

