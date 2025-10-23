// next.config.ts
import type { NextConfig } from "next";

const csp = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com;
  connect-src 'self' https://api.stripe.com https://router.project-osrm.org ${
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  };
  img-src 'self' data: blob: https://images.unsplash.com ${
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  };
  style-src 'self' 'unsafe-inline';
  font-src 'self' data: https://js.stripe.com;
  frame-src https://js.stripe.com https://hooks.stripe.com;
`
  .replace(/\s{2,}/g, " ")
  .trim();

const nextConfig: NextConfig = {
  // 既存の設定があればそのまま残す（例：reactStrictMode, transpilePackages, experimental など）

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "Content-Security-Policy", value: csp }],
      },
    ];
  },
};

export default nextConfig;
