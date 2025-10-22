// apps/store/src/lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
  throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing");

// RLS ポリシーで `x-store-id` ヘッダを参照するため、
// クライアントのデフォルトヘッダに店舗IDを付与する
const storeId = (typeof window !== 'undefined' && (window as any).__STORE_ID__)
  || (process.env.NEXT_PUBLIC_STORE_ID as string | undefined)
  || 'default';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    global: {
      headers: {
        'x-store-id': storeId,
      },
    },
  }
);
