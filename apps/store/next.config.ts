// apps/store/next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // monorepo のローカルパッケージを使用する場合はここでトランスパイル
  transpilePackages: ["@shared"],

  // Vercel の本番/プレビューで ESLint エラーでは落とさない（先に公開を優先）
  eslint: { ignoreDuringBuilds: true },

  // 型エラーでは落とす（必要なら下をコメント解除して無視可能）
  // typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
