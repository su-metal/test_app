// apps/user/src/app/stripe/StripeBoot.tsx
"use client";

import { useEffect } from "react";
import { loadStripe, Stripe } from "@stripe/stripe-js";

/**
 * StripeBoot:
 *  - モジュールスコープで Stripe.js のロードを開始し、
 *    アプリ全体で同じ Promise を再利用して初期遅延を防ぐ。
 *  - UI への副作用なし。Elements 側でこの Promise を共有可能。
 */

const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";
// ★ モジュールスコープでロード開始（アプリ起動直後から並列で取得）
export const stripePromise: Promise<Stripe | null> =
  key ? loadStripe(key) : Promise.resolve(null);

export default function StripeBoot() {
  useEffect(() => {
    // ここで触ることで「useEffect 実行完了＝接続ウォームアップ済み」
    stripePromise.catch(() => {
      /* noop */
    });
  }, []);

  return null; // UI には何も描画しない
}
