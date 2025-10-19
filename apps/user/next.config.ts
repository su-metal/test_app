// next.config.ts
import type { NextConfig } from "next";

/**
 * Content-Security-Policy
 * - まずは動作優先で緩め、段階的に絞り込みます。
 * - Stripe (Embedded), Supabase, Google Maps, LIFF を想定。
 */
const buildCSP = () => {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",

    // 画像：動作優先（後で絞ってOK）
    "img-src 'self' data: blob: https:",

    // フォント（Stripe を許可）
    "font-src 'self' https://*.stripe.com data:",

    // スタイル：実装都合で inline 許可
    "style-src 'self' 'unsafe-inline'",

    // スクリプト：Stripe/Maps を許可（開発で eval を許容）
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://maps.googleapis.com https://maps.gstatic.com",

    // iframe 埋め込み：Stripe / Google
    "frame-src 'self' https://*.stripe.com https://*.google.com",

    // API / WSS
    [
      "connect-src",
      "'self'",
      "https://*.stripe.com",
      "https://api.stripe.com",
      "https://r.stripe.com",
      "https://q.stripe.com",
      "https://*.supabase.co",
      "wss://*.supabase.co",
      "https://maps.googleapis.com",
      "https://maps.gstatic.com",
      // LIFF API エンドポイント（ログイン/プロフィール取得など）
      "https://api.line.me",
      "https://access.line.me",
      // ルート距離取得（OSRM）
      "https://router.project-osrm.org",
    ].join(" "),

    // クリックジャッキング対策
    "frame-ancestors 'self'",

    // フォーム送信
    "form-action 'self' https://*.stripe.com",
  ];

  return directives.join("; ");
};

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: buildCSP() },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },

          // Geolocation を許可（同一オリジン）
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

