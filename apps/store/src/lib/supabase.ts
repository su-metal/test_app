"use client";
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // OAuth/PKCE を使っている場合に必要
    },
  }
);

// ↓ 環境変数の読込チェック（確認後に削除OK）
if (typeof window !== "undefined") {
  (window as any).__ENV_CHECK__ = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKeyHead:
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").slice(0, 10) + "…",
  };
}
