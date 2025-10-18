// apps/user/src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

/**
 * 環境変数が無い場合は開発時に早めに気づけるようにします
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません。"
  );
}

/**
 * 店舗スコープをRLSで通すための必須ヘッダ。
 * 指定のストアID（固定）を常時付与します。
 */
// TODO(req v2): ユーザー側の店舗切替に追随できるよう動的化
const STORE_ID = process.env.NEXT_PUBLIC_STORE_ID;
if (!STORE_ID) {
  throw new Error("[supabase] NEXT_PUBLIC_STORE_ID が設定されていません。");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      "x-store-id": STORE_ID,
    },
  },
});
