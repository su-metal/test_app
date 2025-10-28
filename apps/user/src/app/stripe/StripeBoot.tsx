"use client";

import { useEffect } from "react";
import { loadStripe } from "@stripe/stripe-js";

/**
 * StripeBoot: アプリ起動早期に Stripe.js を初期化して接続をウォームアップ
 * TODO(req v2): 本番では publishable key のローテーション方針に合わせて更新検知を追加
 */
export default function StripeBoot() {
  useEffect(() => {
    let mounted = true;
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!key) return;
    // 失敗しても UI へ影響しない。ログ出力も抑制。
    loadStripe(key).catch(() => { /* noop */ });
    return () => { mounted = false; };
  }, []);
  return null;
}

