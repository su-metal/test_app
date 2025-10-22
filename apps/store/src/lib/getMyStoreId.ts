// apps/store/src/lib/getMyStoreId.ts
import { supabase } from "./supabaseClient";

/**
 * ログイン中ユーザーに紐づく stores.id を取得
 * RLS: stores.auth_user_id = auth.uid() で自分の1件だけ読める前提
 */
export async function getMyStoreId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.id) throw new Error("unauthorized");

  const { data, error } = await supabase
    .from("stores")
    .select("id")
    .eq("auth_user_id", auth.user.id)
    .single();

  if (error || !data?.id) throw new Error("store not found");
  return data.id;
}
