// next.config.ts
import type { NextConfig } from "next";

/**
 * Content-Security-Policy
 * - img-src はまず https: を許可して動作を安定化（後で必要ドメインに絞ってOK）
 * - Stripe (Embedded), Supabase, Google Maps を想定
 */
const buildCSP = () => {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",

    // 画像：動作優先（後で絞ってOK）
    "img-src 'self' data: blob: https:",

    // フォント（Stripe）
    "font-src 'self' https://*.stripe.com data:",

    // スタイル（UI都合で inline 許可）
    "style-src 'self' 'unsafe-inline'",

    // スクリプト（Stripe/Maps、開発の eval を許容）
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://maps.googleapis.com https://maps.gstatic.com",

    // iframe 埋め込み（Stripe/Google）
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
      // ルート距離取得（OSRM）。これが無いと fetch がブロックされ「距離算定中」のままになります。
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

          /**
           * ✅ ここがポイント：Geolocation を許可
           *   - 以前の geolocation=() は「常に拒否」で現在地取得が失敗していました。
           *   - geolocation=(self) なら同一オリジンのページで有効になります。
           */
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
