// apps/store/src/lib/pickupPresets.ts
import { supabase } from "./supabaseClient";
import { getMyStoreId } from "./getMyStoreId";
// TODO(req v2): LINEミニアプリ経由の保存にも対応
// 注意: LIFFはブラウザ環境でのみ動作
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import liff from "@line/liff";

export type PickupPreset = {
  slot_no: number; // ユニークキー片割れ
  name: string;
  start_time: string; // 'HH:mm' など、DB型に合わせて
  end_time: string;
  slot_minutes: number;
  // store_id は内部で解決するので引数に不要
};

/** upsert: store_id + slot_no が同一ならマージ */
export async function upsertPickupPreset(preset: PickupPreset) {
  const store_id = await getMyStoreId();

  const { error } = await supabase.from("store_pickup_presets").upsert(
    { store_id, ...preset },
    { onConflict: "store_id,slot_no" } // ← RESTのon_conflictに相当
  );

  if (error) throw error;
}

/** 複数件まとめて upsert したい場合 */
export async function upsertPickupPresets(presets: PickupPreset[]) {
  const store_id = await getMyStoreId();
  const rows = presets.map((p) => ({ store_id, ...p }));
  const { error } = await supabase
    .from("store_pickup_presets")
    .upsert(rows, { onConflict: "store_id,slot_no" });
  if (error) throw error;
}

/**
 * LIFFのIDトークンを用いてServer Route経由でupsert（ミニアプリ用）
 * - サーバー側で service_role によりRLSをバイパスしつつ、store_membersで権限確認
 */
export async function upsertPickupPresetsViaApi(presets: PickupPreset[]) {
  const store_id = await getMyStoreId();
  const rows = presets.map((p) => ({ store_id, ...p }));

  // 開発時も API を叩く（Route 側で LIFF スキップを許可）
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID as string | undefined;
  let idToken: string | undefined;
  if (process.env.NEXT_PUBLIC_DEV_SKIP_LIFF !== '1') {
    if (!liffId) throw new Error("LIFFの設定が不足しています(NEXT_PUBLIC_LIFF_ID)");
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) liff.login();
    idToken = liff.getIDToken() || undefined;
    if (!idToken) throw new Error("LINEのIDトークンが取得できませんでした");
  }

  const res = await fetch('/api/presets/upsert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { 'x-line-id-token': idToken } : {}),
    },
    body: JSON.stringify(rows),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || 'プリセットの保存に失敗しました');
}
