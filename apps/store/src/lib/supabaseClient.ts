// apps/store/src/lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
  throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing");

// RLS ポリシーで `x-store-id` ヘッダを参照するため、
// クライアントのデフォルトヘッダに店舗IDを付与する
const rawStoreId = (typeof window !== 'undefined' && (window as any).__STORE_ID__) || '';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    global: {
      headers: {
        // 空文字を送らない
        ...(rawStoreId ? { 'x-store-id': String(rawStoreId) } : {}),
      },
    },
  }
);
