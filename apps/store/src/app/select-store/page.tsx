"use client";
import React from "react";
import { useRouter } from "next/navigation";

function StoreRow({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  const onChoose = async () => {
    if (loading) return;
    setLoading(true);

    const res = await fetch("/api/auth/session/select-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      // TODO(req v2): プロパティ名は storeId で統一
      body: JSON.stringify({ storeId: id, store_id: id }),
    });

    if (!res.ok) {
      setLoading(false);
      alert("店舗の選択に失敗しました。もう一度お試しください。");
      return;
    }

    // 選択完了後にホームへ
    router.replace("/");
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
  const [stores, setStores] = React.useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/auth/session/list-stores", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });
        if (res.status === 401) {
          if (alive) {
            setError("認証が切れました。再ログインしてください。");
            setStores([]);
          }
          return;
        }
        if (!res.ok) {
          if (alive) {
            setError("店舗一覧の取得に失敗しました。");
            setStores([]);
          }
          return;
        }
        const json = (await res.json()) as { ok?: boolean; stores?: Array<{ id: string; name?: string | null }> };
        const items = (json?.stores || []).map((s) => ({ id: String(s.id), name: String(s.name ?? "(名称未設定)") }));
        if (alive) setStores(items);
      } catch {
        if (alive) {
          setError("店舗一覧の取得に失敗しました。");
          setStores([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold mb-3">店舗選択</h1>
      <p className="text-sm text-zinc-600 mb-4">操作する店舗を選択してください（閲覧はログイン済みのみ）。</p>
      {error && (
        <div className="mb-3 text-sm text-red-600">
          {error} <a href="/login" className="underline">ログインへ</a>
        </div>
      )}
      <div className="space-y-3">
        {loading ? (
          <div className="text-sm text-zinc-500">読み込み中…</div>
        ) : stores.length === 0 ? (
          <div className="text-sm text-zinc-500">選択可能な店舗がありません。</div>
        ) : (
          stores.map((s) => <StoreRow key={s.id} id={s.id} name={s.name} />)
        )}
      </div>
    </div>
  );
}

