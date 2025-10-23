// apps/store/src/lib/pickupPresets.ts
import { getMyStoreId } from "./getMyStoreId";
// RLS 側で x-store-id ヘッダーを参照する既存ポリシー互換のため、
// supabaseClient（グローバルヘッダー付与版）を使用する。
import { supabase } from "./supabaseClient";
import { createClient } from "@supabase/supabase-js";

export type PickupPreset = {
  slot_no: number;
  name: string;
  start_time: string; // 'HH:mm' 推奨（DB time 型。秒は 00 固定で可）
  end_time: string;
  slot_minutes: number;
};

// Supabase Auth セッションの RLS を通して直接 upsert
export async function upsertPickupPreset(preset: PickupPreset) {
  return upsertPickupPresets([preset]);
}

// Supabase Auth セッションの RLS を通して直接 upsert
export async function upsertPickupPresets(presets: PickupPreset[]) {
  const store_id = await getMyStoreId();
  const rows = presets.map((p) => ({
    store_id,
    slot_no: p.slot_no,
    name: p.name,
    start_time: p.start_time,
    end_time: p.end_time,
    slot_minutes: p.slot_minutes ?? 10,
  }));

  // 既存RLSが x-store-id を参照する環境に合わせ、
  // この保存処理だけは store_id 固定のヘッダーを持つ一時クライアントを使う。
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const sbForWrite = createClient(url, key, { global: { headers: { 'x-store-id': store_id } } });

  const { error } = await sbForWrite
    .from("store_pickup_presets")
    // TODO(req v2): DB側で primary key(store_id, slot_no) を保証
    .upsert(rows, { onConflict: "store_id,slot_no" });

  if (error) {
    throw new Error(error.message || "プリセットの保存に失敗しました");
  }
}

// TODO(req v2): 旧実装（LIFF + service_role API）は撤去。ロールバック用途は環境変数で復帰する場合のみ別モジュールに隔離する。
