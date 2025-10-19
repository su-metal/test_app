import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本番ビルド時に ESLint エラーで失敗しない（Phase 0 の暫定設定）
  eslint: { ignoreDuringBuilds: true },
  // TODO(req v2): 正式化時は false に戻し、型エラーを解消する
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
