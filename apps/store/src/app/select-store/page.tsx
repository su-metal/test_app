"use client";
import { useEffect, useState } from "react";

type Store = { id: string; name?: string | null };

export default function SelectStorePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch('/api/auth/session/list-stores', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setErr(j?.error || '店舗の取得に失敗しました'); return; }
        setStores(Array.isArray(j?.stores) ? j.stores : []);
      } catch (e: any) {
        setErr(e?.message || '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onSelect(storeId: string) {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/api/auth/session/select-store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storeId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.error || '選択に失敗しました'); return; }
      // 選択後はトップへ
      location.replace('/');
    } catch (e: any) {
      setErr(e?.message || '選択に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-6 max-w-md mx-auto">
      <h1 className="text-lg font-semibold mb-3">店舗を選択</h1>
      <p className="text-sm text-zinc-600 mb-3">操作する店舗を選んでください（切替は再ログインのみ）。</p>
      {err ? <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2 mb-3">{err}</div> : null}
      <div className="space-y-2">
        {stores.map(s => (
          <button key={s.id} disabled={loading} onClick={() => onSelect(s.id)} className="w-full rounded border px-3 py-2 text-left hover:bg-zinc-50">
            <div className="font-medium">{s.name || '店舗'}</div>
            <div className="text-xs text-zinc-500">{s.id}</div>
          </button>
        ))}
        {(!loading && stores.length === 0) ? <div className="text-sm text-zinc-600">選択可能な店舗がありません。</div> : null}
      </div>
    </main>
  );
}

