// apps/user/next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // monorepo内のローカルパッケージをNextにトランスパイルさせる（使っていなければ残してOK）
  transpilePackages: ["@shared"],

  // ★ Vercel 本番ビルドで ESLint エラーでは落とさない（まずは公開優先）
  eslint: { ignoreDuringBuilds: true },

  // 型エラーでは落とす（安全性は担保）。必要なら false→true に変更可。
  // typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
