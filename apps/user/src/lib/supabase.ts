// apps/user/src/lib/supabase.ts
"use client";

import { createClient } from "@supabase/supabase-js";

/**
 * 環境変数の読み込み（未設定なら早めに気付けるよう例外）
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// 任意: ユーザー側でも store 固有ヘッダを付ける運用なら使う
const STORE_ID = process.env.NEXT_PUBLIC_STORE_ID;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "[supabase(user)] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません。"
  );
}

/**
 * supabase-js クライアントを単一箇所で生成
 * - auth.persistSession: ブラウザでセッションを保持
 * - auth.autoRefreshToken: 期限が切れる前に自動更新
 * - auth.detectSessionInUrl: PKCE/OAuth でURLからセッション抽出
 *   （メールリンク/LINEログインなどのフローなら true 推奨）
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // flowType: 'pkce', // PKCE を明示して使っているならコメントアウトを外す
  },
  global: {
    headers: STORE_ID ? { "x-store-id": STORE_ID } : {},
  },
});

/**
 * ▼ENV チェック用（本番で一度だけ Console から確認して、終わったら削除OK）
 * DevTools Console:  window.__ENV_CHECK__
 */
if (typeof window !== "undefined") {
  (window as any).__ENV_CHECK__ = {
    supabaseUrl: SUPABASE_URL,
    anonKeyHead: (SUPABASE_ANON_KEY || "").slice(0, 10) + "…",
    storeId: STORE_ID ?? null,
  };
}
