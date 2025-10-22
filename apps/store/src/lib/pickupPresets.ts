// apps/store/src/lib/pickupPresets.ts
import { getMyStoreId } from "./getMyStoreId";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import liff from "@line/liff";

export type PickupPreset = {
  slot_no: number;
  name: string;
  start_time: string; // 'HH:mm' 等（DB 型に合わせること）
  end_time: string;
  slot_minutes: number;
};

// 本番では RLS によりクライアントからの直接 upsert は失敗するため禁止
export async function upsertPickupPreset(preset: PickupPreset) {
  return upsertPickupPresetsViaApi([preset]);
}

// 本番では RLS によりクライアントからの直接 upsert は失敗するため禁止
export async function upsertPickupPresets(presets: PickupPreset[]) {
  return upsertPickupPresetsViaApi(presets);
}

/**
 * LIFF の ID トークンで認証し、サーバー Route 経由で upsert
 * - サーバー側で service_role を用いて RLS を迂回し、store_members 等で権限を検証
 */
export async function upsertPickupPresetsViaApi(presets: PickupPreset[]) {
  const store_id = await getMyStoreId();
  const rows = presets.map((p) => ({ store_id, ...p }));

  // 既定は API 経由（Route で LIFF サイン検証）
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID as string | undefined;
  let idToken: string | undefined;
  if (process.env.NEXT_PUBLIC_DEV_SKIP_LIFF !== "1") {
    if (!liffId) throw new Error("LIFFの設定が不足しています (NEXT_PUBLIC_LIFF_ID)");
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) {
      // 現在のページに戻す（ユーザーアプリへ遷移しない）
      liff.login({ redirectUri: `${window.location.origin}${window.location.pathname}${window.location.search}` });
      return; // 以降はリダイレクトされるため終了
    }
    idToken = liff.getIDToken() || undefined;
    if (!idToken) throw new Error("LINEのIDトークンが取得できませんでした");
  }

  const res = await fetch("/api/presets/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { "x-line-id-token": idToken } : {}),
    },
    body: JSON.stringify(rows),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || "プリセットの保存に失敗しました");
}
