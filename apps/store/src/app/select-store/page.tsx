"use client";
import React from "react";
import { useRouter } from "next/navigation";

// 既存で取得している stores 配列を使います。
// 例: const stores = [{ id, name }, ...];

function StoreRow({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  const onChoose = async () => {
    if (loading) return;
    setLoading(true);

    // サーバ側セッションに store_id を保存（Cookie 往復のため credentials 必須）
    const res = await fetch("/api/auth/session/select-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",               // ★これが無いと戻されます
      body: JSON.stringify({ store_id: id }),
    });

    if (!res.ok) {
      setLoading(false);
      alert("店舗の選択に失敗しました。もう一度お試しください。");
      return;
    }

    // 成功後にホームへ（履歴を残さない）
    router.replace("/");
    // 強制再読み込みしたい場合は:
    // location.replace("/");
  };

  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={loading}
      className="w-full text-left rounded-lg border p-3 hover:bg-zinc-50 disabled:opacity-50"
    >
      <div className="font-semibold">{name}</div>
      <div className="text-xs text-zinc-500">{id}</div>
    </button>
  );
}

export default function SelectStorePage() {
  // ここで stores を取得している既存ロジックを残し、その配列を使って描画してください。
  // 例:
  // const stores = await fetch(...).then(r => r.json());

  const [stores, setStores] = React.useState<Array<{ id: string; name: string }>>([]);

  // ↑ stores の取得はあなたの現行実装に合わせてください。以下は描画のみの例です。
  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold mb-3">店舗を選択</h1>
      <p className="text-sm text-zinc-600 mb-4">操作する店舗を選んでください（切替は再ログインのみ）。</p>
      <div className="space-y-3">
        {stores.length === 0 ? (
          <div className="text-sm text-zinc-500">選択可能な店舗がありません。</div>
        ) : (
          stores.map((s) => <StoreRow key={s.id} id={s.id} name={s.name} />)
        )}
      </div>
    </div>
  );
}
