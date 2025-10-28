export default function Head() {
  return (
    <>
      {/* Stripe と関連ドメインのウォームアップ */}
      {/* TODO(req v2): CSP の設定に合わせて必要最小限に最適化 */}
      <link rel="preconnect" href="https://js.stripe.com" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://js.stripe.com" />

      <link rel="preconnect" href="https://api.stripe.com" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://api.stripe.com" />

      <link rel="preconnect" href="https://m.stripe.com" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://m.stripe.com" />
    </>
  );
}

