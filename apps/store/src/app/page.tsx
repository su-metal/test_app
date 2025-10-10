"use client";
import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

// 要件: 店側 UI（注文一覧、受け渡し、商品管理）。日本語文言で統一。
// TODO(req v2): DB スキーマ型は生成定義に切替（supabase gen types）。

// ===== 型定義 =====
type OrderStatus = "PENDING" | "FULFILLED";

type OrderItem = {
  id: string;
  name: string;
  qty: number;
};

type OrdersRow = {
    id: string;
    store_id?: string | null;
    code: string | null;
    customer: string | null;
    items: OrderItem[] | null;
    total: number | null;
    placed_at: string | null;
    status: OrderStatus;
};

type Order = {
    id: string;
    storeId: string;
    code: string | null;
    customer: string;
    items: OrderItem[];
    total: number;
    placedAt: string;
    status: OrderStatus;
};

type ProductsRow = {
  id: string;
  store_id?: string | null;
  name: string;
  price: number | null;
  stock: number | null;
  updated_at: string | null;
};

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
};

// ===== Util =====
const getStoreId = () =>
  (typeof window !== "undefined" && (window as any).__STORE_ID__) ||
  (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_STORE_ID as string | undefined)) ||
  "default";

const yen = (n: number) => n.toLocaleString("ja-JP", { style: "currency", currency: "JPY" });
const since = (iso: string) => {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間前`;
};
const storeTake = (price: number | string) => Math.floor(Number(price || 0) * 0.8);
function useMounted() { const [m, sm] = useState(false); useEffect(() => sm(true), []); return m; }

// 6桁コード正規化（非数字除去し6桁に丸める）
// 注意: 入力側は「6桁入力必須」。比較時のみ期待値はゼロ埋め許容。
function normalizeCode6(v: unknown): string {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  return digits.slice(-6);
}

// 正規化
function mapOrder(r: OrdersRow): Order {
  const raw = String(r.status || '').toUpperCase();
  const status: OrderStatus = (raw === 'FULFILLED' || raw === 'REDEEMED' || raw === 'COMPLETED')
    ? 'FULFILLED'
    : 'PENDING'; // 'PAID' を含むその他は PENDING とみなす
  return {
    id: String(r.id),
    storeId: String((r as any).store_id ?? ''),
    code: r.code ?? null,
    customer: r.customer ?? "匿名",
    items: Array.isArray(r.items) ? r.items : [],
    total: Number(r.total ?? 0),
    placedAt: r.placed_at ?? new Date().toISOString(),
    status,
  };
}
function mapProduct(r: ProductsRow): Product { return { id: String(r.id), name: r.name, price: Number(r.price ?? 0), stock: Math.max(0, Number(r.stock ?? 0)) }; }

// ===== Supabase クライアント =====
function useSupabase() {
  return useMemo(() => {
    if (typeof window === "undefined") return null;
    const w = window as any;
    if (w.__supabase) return w.__supabase;
    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined) || w.NEXT_PUBLIC_SUPABASE_URL;
    const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined) || w.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sid = getStoreId();
    if (!url || !key) return null;
    try {
      const sb = createClient(url, key, { global: { headers: { 'x-store-id': String(sid || '') } } });
      (w as any).__supabase = sb;
      return sb;
    } catch {
      return null;
    }
  }, []);
}

// ===== Stores =====
type StoreRow = { id: string; name: string; created_at?: string };
function useStores() {
  const supabase = useSupabase();
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!supabase) return; setLoading(true); setErr(null);
    const { data, error } = await supabase.from('stores').select('id,name,created_at').order('created_at', { ascending: true }).limit(200);
    if (error) setErr(error.message || '店舗の取得に失敗しました'); else setStores((data as StoreRow[]) || []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);
  return { stores, loading, err } as const;
}

const StoreSwitcher = React.memo(function StoreSwitcher() {
  const { stores } = useStores();
  const [sel, setSel] = useState<string>(() => {
    if (typeof window === 'undefined') return getStoreId();
    try { return localStorage.getItem('store:selected') || getStoreId(); } catch { return getStoreId(); }
  });
  useEffect(() => setSel(getStoreId()), []);
  const onChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value; setSel(v);
    try { localStorage.setItem('store:selected', v); } catch {}
    (window as any).__STORE_ID__ = v; location.reload();
  }, []);
  return (
    <label className="flex items-center gap-2 text-sm mr-2">
      <span className="text-zinc-600">店舗</span>
      <select value={sel} onChange={onChange} className="rounded-lg border px-2 py-1 bg-white">
        {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
});

// ===== Broadcast helper =====
function useBroadcast(name: string) {
  const chan = useMemo(() => { if (typeof window === 'undefined') return null; try { return new BroadcastChannel(name); } catch { return null; } }, [name]);
  const post = (payload: unknown) => { try { (chan as BroadcastChannel | null)?.postMessage(payload as any); } catch { } };
  useEffect(() => () => { try { (chan as BroadcastChannel | null)?.close(); } catch { } }, [chan]);
  return { post } as const;
}

// ===== Products =====
function useProducts() {
  const supabase = useSupabase();
  const [products, setProducts] = useState<Product[]>([]);
  const [perr, setPerr] = useState<string | null>(null);
  const [ploading, setPloading] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return; setPloading(true); setPerr(null);
    const { data, error } = await supabase.from('products').select('*').eq('store_id', getStoreId()).order('updated_at', { ascending: false });
    if (error) setPerr(error.message || '商品の取得に失敗しました');
    else setProducts(((data ?? []) as ProductsRow[]).map(mapProduct));
    setPloading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const add = useCallback(async (payload: { name: string; price: number; stock: number }) => {
    if (!payload.name) { setPerr('商品名を入力してください'); return; }
    if (!supabase) return;
    setPloading(true); setPerr(null);
    const { data, error } = await supabase.from('products').insert({ ...payload, store_id: getStoreId() }).select('*').single();
    if (error) setPerr(error.message || '商品の登録に失敗しました');
    else if (data) setProducts(prev => [mapProduct(data as ProductsRow), ...prev]);
    setPloading(false);
  }, [supabase]);

  const remove = useCallback(async (id: string) => {
    if (!id) return; setProducts(prev => prev.filter(p => p.id !== id));
    if (!supabase) return;
    const { error } = await supabase.from('products').delete().eq('id', id).eq('store_id', getStoreId());
    if (error) setPerr(error.message || '削除に失敗しました');
  }, [supabase]);

  return { products, perr, ploading, add, remove, reload: load } as const;
}

// ===== Orders =====
function useOrders() {
  const supabase = useSupabase();
  const invChan = useBroadcast('inventory-sync');
  const orderChan = useBroadcast('order-sync');

  const [orders, setOrders] = useState<Order[]>([]);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const chanName = `orders-realtime-${getStoreId()}`;

  const cleanup = useCallback(() => {
    try { channelRef.current?.unsubscribe?.(); } catch { }
    try { if (supabase && channelRef.current) (supabase as any).removeChannel(channelRef.current); } catch { }
    channelRef.current = null;
  }, [supabase]);

  const decrementStocksDB = useCallback(async (items: OrderItem[]) => {
    if (!supabase) return;
    await Promise.all(items.map(async it => {
      const { data: prod } = await supabase.from('products').select('id,stock').eq('id', it.id).single();
      if (prod) { const next = Math.max(0, Number((prod as any).stock || 0) - it.qty); await supabase.from('products').update({ stock: next }).eq('id', it.id); }
    }));
    invChan.post({ type: 'DECREMENT_STOCK', items: items.map(({ id, qty }) => ({ id, qty })) });
  }, [supabase, invChan]);

  const fetchAndSubscribe = useCallback(async () => {
    if (!supabase) { setReady(true); return; }
    setErr(null); cleanup();
    const { data, error } = await supabase.from('orders').select('*').eq('store_id', getStoreId()).order('placed_at', { ascending: false });
    if (error) setErr(error.message || 'データ取得に失敗しました'); else setOrders(((data ?? []) as OrdersRow[]).map(mapOrder));
    try {
      const sid = getStoreId();
      const ch = (supabase as any)
        .channel(chanName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter: `store_id=eq.${sid}` }, (p: any) => { if (p?.new) setOrders(prev => [mapOrder(p.new as OrdersRow), ...prev]); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${sid}` }, (p: any) => { if (p?.new) setOrders(prev => prev.map(o => o.id === String((p.new as OrdersRow).id) ? mapOrder(p.new as OrdersRow) : o)); })
        // NOTE: DELETE は REPLICA IDENTITY 設定次第で old に store_id が含まれないため、フィルタを外す
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'orders' }, (p: any) => {
          const oldRow = (p?.old as any) || {};
          const id = String(oldRow.id || '');
          if (!id) return;
          setOrders(prev => prev.filter(o => o.id !== id));
        })
        .subscribe() as RealtimeChannel;
      channelRef.current = ch;
    } catch { setErr('リアルタイム購読に失敗しました'); }
    setReady(true);
  }, [supabase, cleanup, chanName]);

  useEffect(() => { fetchAndSubscribe(); return () => { cleanup(); }; }, [fetchAndSubscribe, cleanup]);

  const fulfill = useCallback(async (id: string) => {
    const target = orders.find(o => o.id === id); if (!target) return;
    if (!supabase) { setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'FULFILLED' } : o)); orderChan.post({ type: 'ORDER_FULFILLED', orderId: id, at: Date.now() }); return; }
    const { data, error } = await supabase.from('orders').update({ status: 'FULFILLED' }).eq('id', id).eq('store_id', getStoreId()).select('*').single();
    if (error) { setErr(error.message || '更新に失敗しました'); return; }
    if (data) { setOrders(prev => prev.map(o => o.id === String((data as OrdersRow).id) ? mapOrder(data as OrdersRow) : o)); await decrementStocksDB(target.items); orderChan.post({ type: 'ORDER_FULFILLED', orderId: String((data as OrdersRow).id), at: Date.now() }); }
  }, [supabase, orders, decrementStocksDB, orderChan]);

  const clearPending = useCallback(async () => {
    if (!(typeof window !== 'undefined' && window.confirm('「受取待ちの注文」をすべて削除しますか？'))) return;
    if (!supabase) { setOrders(prev => prev.filter(o => o.status !== 'PENDING')); return; }
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('store_id', getStoreId())
      .eq('status', 'PENDING');
    if (error) { setErr(error.message || '削除に失敗しました'); return; }
    setOrders(prev => prev.filter(o => o.status !== 'PENDING'));
  }, [supabase]);
  const clearFulfilled = useCallback(async () => {
    if (!(typeof window !== 'undefined' && window.confirm('「受け渡し済み」の注文をすべて削除しますか？'))) return;
    if (!supabase) { setOrders(prev => prev.filter(o => o.status !== 'FULFILLED')); return; }
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('store_id', getStoreId())
      .eq('status', 'FULFILLED');
    if (error) { setErr(error.message || '削除に失敗しました'); return; }
    setOrders(prev => prev.filter(o => o.status !== 'FULFILLED'));
  }, [supabase]);

  const pending = useMemo(() => orders.filter(o => o.status === 'PENDING'), [orders]);
  const fulfilled = useMemo(() => orders.filter(o => o.status === 'FULFILLED'), [orders]);
  return { ready, err, orders, pending, fulfilled, fulfill, clearPending, clearFulfilled, retry: fetchAndSubscribe } as const;
}

// ===== UI =====
const SectionTitle = React.memo(function SectionTitle({ children, badge }: { children: React.ReactNode; badge?: string; }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {badge ? (<span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">{badge}</span>) : null}
    </div>
  );
});

const StatusBadge = React.memo(function StatusBadge({ status }: { status: OrderStatus; }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border ${status === 'PENDING' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
      {status === 'PENDING' ? '受取待ち' : '受け渡し済み'}
    </span>
  );
});

const OrderCard = React.memo(function OrderCard({ order, onHandoff }: { order: Order; onHandoff: (o: Order) => void; }) {
  const onClick = useCallback(() => onHandoff(order), [onHandoff, order]);
  const mounted = useMounted();
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">{order.customer}</div>
        <StatusBadge status={order.status} />
      </div>
      <div className="text-sm text-zinc-600">注文ID: {order.id}</div>
      <ul className="text-sm text-zinc-800 space-y-1">
        {order.items.map((it) => (
          <li key={it.id} className="flex items-center justify-between">
            <span>{it.name}</span>
            <span className="tabular-nums">×{it.qty}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-500" suppressHydrationWarning>
          受付 {mounted ? since(order.placedAt) : ''}
        </span>
        <span className="font-semibold">{yen(order.total)}</span>
      </div>
      {order.status === 'PENDING' ? (
        <button onClick={onClick} className="w-full rounded-xl bg-zinc-900 text-white py-2.5 text-sm font-medium hover:bg-zinc-800 active:opacity-90">受け渡し（コード照合）</button>
      ) : (
        <div className="w-full rounded-xl bg-emerald-600/10 text-emerald-700 py-2.5 text-sm text-center font-medium">受け渡し完了</div>
      )}
    </div>
  );
});

// 簡易QRスキャナ（BarcodeDetector対応ブラウザのみ）
function QRScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void; }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | undefined; let detector: any; let raf: number | undefined;
    (async () => {
      try {
        const supports = typeof window !== 'undefined' && 'BarcodeDetector' in window;
        if (supports) {
          detector = new (window as any).BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128'] });
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = videoRef.current; if (!v) return; (v as any).srcObject = stream; await v.play();
        if (detector) {
          const loop = async () => {
            try {
              const codes = await detector.detect(v);
              if (codes && codes.length > 0) {
                const raw = String(codes[0].rawValue ?? codes[0].rawText ?? '');
                onDetect(normalizeCode6(raw));
              } else { raf = requestAnimationFrame(loop); }
            } catch { raf = requestAnimationFrame(loop); }
          };
          raf = requestAnimationFrame(loop);
        }
      } catch (e) { setErr('カメラ起動に失敗しました'); }
    })();
    return () => { try { if (raf) cancelAnimationFrame(raf); } catch {} try { const v = videoRef.current as any; if (v) v.pause?.(); } catch {} try { stream?.getTracks?.().forEach(t => t.stop()); } catch {} };
  }, [onDetect]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold mb-2">QRを読み取る</div>
        <div className="aspect-[4/3] bg-black/80 rounded-xl overflow-hidden mb-3">
          <video ref={videoRef} className="w-full h-full object-contain" muted playsInline />
        </div>
        {err ? <div className="text-sm text-red-600 mb-2">{err}</div> : null}
        <div className="text-right">
          <button className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

function ProductForm() {
  const { products, perr, ploading, add, remove } = useProducts();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("");
  const take = storeTake(Number(price || 0));

  return (
    <div className="rounded-2xl border bg-white p-4 space-y-3">
      <SectionTitle>商品</SectionTitle>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); add({ name: name.trim(), price: Number(price || 0), stock: Number(stock || 0) }); setName(""); setPrice(""); setStock(""); }}>
        <input className="rounded-xl border px-3 py-2 text-sm" placeholder="商品名" value={name} onChange={e => setName(e.target.value)} required />
        <input className="rounded-xl border px-3 py-2 text-sm" placeholder="価格" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value)} />
        <input className="rounded-xl border px-3 py-2 text-sm" placeholder="在庫" inputMode="numeric" value={stock} onChange={e => setStock(e.target.value)} />
        <input className="rounded-xl border px-3 py-2 text-sm bg-zinc-50" value={`店側受取額 ${yen(take)}`} readOnly aria-label="店側受取額" />
        <button className="rounded-xl bg-zinc-900 text-white px-3 py-2 text-sm" disabled={ploading}>追加</button>
      </form>
      {perr ? <div className="text-sm text-red-600">{perr}</div> : null}
      <div className="grid grid-cols-1 gap-2">
        {products.map(p => (
          <div key={p.id} className="rounded-xl border p-3 text-sm flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="font-medium">{p.name}</div>
              <div className="text-zinc-600 text-xs">店側受取額 {yen(storeTake(p.price))}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold">{yen(p.price)}</div>
              <div className="text-xs text-zinc-500">在庫 {p.stock}</div>
              <button type="button" className="mt-2 inline-flex items-center rounded-lg border px-2 py-1 text-xs text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50" onClick={() => { if (confirm(`「${p.name}」を削除しますか？`)) remove(p.id); }} disabled={ploading} aria-label={`${p.name} を削除`}>削除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrdersPage() {
  const { ready, err, pending, fulfilled, fulfill, clearPending, clearFulfilled, retry } = useOrders();
  const [current, setCurrent] = useState<Order | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  // 店舗名の表示用にマスタ取得
  const { stores } = useStores();
  const storeMap = useMemo(() => new Map(stores.map(s => [String(s.id), s.name])), [stores]);
  const currentStoreName = storeMap.get(getStoreId()) || getStoreId();
  // 期待値はゼロ埋めで6桁化（DBの表記ゆらぎ吸収）
  const expectedCode = normalizeCode6(current?.code ?? "");
  // 入力は6桁必須（ゼロ埋めしない）
  const inputDigits = String(codeInput ?? '').replace(/\D/g, '');
  const storeOk = !!current && current.storeId === getStoreId();
  const canFulfill = storeOk && expectedCode.length === 6 && inputDigits.length === 6 && inputDigits === expectedCode;
  return (
    <main className="mx-auto max-w-[480px] px-4 py-5 space-y-6">
      {!ready && (<div className="rounded-xl border bg-white p-4 text-sm text-zinc-600">読み込み中…</div>)}
      {err ? (<div className="rounded-xl border bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between"><span>{err}</span><button onClick={retry} className="rounded-lg bg-red-600 text-white px-3 py-1 text-xs">リトライ</button></div>) : null}
      <section>
        <div className="mb-2 flex justify-end">
          <StoreSwitcher />
        </div>
        <SectionTitle badge={`${pending.length}件`}>受取待ちの注文</SectionTitle>
        <div className="flex justify-end mb-2">
          <button
            type="button"
            onClick={clearPending}
            disabled={pending.length === 0}
            className="inline-flex items-center rounded-lg border px-3 py-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
            aria-disabled={pending.length === 0}
          >未引換を一括削除</button>
        </div>
        {pending.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">現在、受取待ちの注文はありません。</div>) : (
          <div className="grid grid-cols-1 gap-4">{pending.map(o => (<OrderCard key={o.id} order={o} onHandoff={setCurrent} />))}</div>
        )}
      </section>
      <section>
        <SectionTitle badge={`${fulfilled.length}件`}>受け渡し済み</SectionTitle>
        <div className="flex justify-end mb-2">
          <button
            type="button"
            onClick={clearFulfilled}
            disabled={fulfilled.length === 0}
            className="inline-flex items-center rounded-lg border px-3 py-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
            aria-disabled={fulfilled.length === 0}
          >一括削除</button>
        </div>
        {fulfilled.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">まだ受け渡し済みの注文はありません。</div>) : (
          <div className="grid grid-cols-1 gap-4 opacity-90">{fulfilled.map(o => (<OrderCard key={o.id} order={o} onHandoff={() => {}} />))}</div>
        )}
      </section>
      {current && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" onClick={() => setCurrent(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-5" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <div className="text-base font-semibold">コード照合</div>
              <div className="text-sm text-zinc-600">注文ID {current.id} / 顧客 {current.customer} / 店舗 {storeMap.get(current.storeId) || current.storeId}</div>
              <div className="mt-3 space-y-2">
                <label className="block text-sm">
                  <span className="text-zinc-700">6桁コード</span>
                  <input
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                    placeholder="000000"
                    inputMode="numeric"
                    value={codeInput}
                    onChange={e => { setCodeInput(e.target.value); setCodeErr(null); }}
                    autoFocus
                  />
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => setScanOpen(true)}>QRで読み取り</button>
                  {expectedCode ? (
                    <span className="text-xs text-zinc-500">照合対象: •••••{expectedCode.slice(-1)}</span>
                  ) : (
                    <span className="text-xs text-red-600">コード未登録の注文です</span>
                  )}
                  {!storeOk && current ? (
                    <span className="text-xs text-red-600">店舗が一致しません（注文: {storeMap.get(current.storeId) || current.storeId} / 現在: {currentStoreName}）</span>
                  ) : null}
                </div>
                {codeErr ? <div className="text-sm text-red-600">{codeErr}</div> : null}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setCurrent(null)} className="rounded-xl border px-4 py-2 text-sm">キャンセル</button>
              <button
                onClick={() => {
                  const raw = String(codeInput ?? '').replace(/\D/g, '');
                  if (!expectedCode || expectedCode.length !== 6) { setCodeErr('この注文にはコードが登録されていません'); return; }
                  if (!storeOk) { setCodeErr('店舗が一致しません'); return; }
                  if (raw.length !== 6) { setCodeErr('6桁のコードを入力してください'); return; }
                  if (raw !== expectedCode) { setCodeErr('コードが一致しません'); return; }
                  fulfill(current.id);
                  setCurrent(null); setCodeInput(""); setCodeErr(null);
                }}
                className={`rounded-xl px-4 py-2 text-sm text-white ${canFulfill ? 'bg-zinc-900' : 'bg-zinc-400 cursor-not-allowed'}`}
                disabled={!canFulfill}
              >受け渡し</button>
            </div>
          </div>
        </div>
      )}

      {scanOpen && (
        <QRScanner
          onDetect={(raw) => { setCodeInput(raw); setCodeErr(null); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}
    </main>
  );
}

function ProductsPage() { return (<main className="mx-auto max-w-4xl px-4 py-5 space-y-8"><ProductForm /><div className="text-xs text-zinc-500">※ 商品管理は単一ページとして暫定運用。ブックマーク例: <code>#/products</code></div></main>); }

export default function StoreApp() {
  const mounted = useMounted();
  const [route, setRoute] = useState<'orders' | 'products'>('orders');
  useEffect(() => {
    const read = () => { const h = (typeof window !== 'undefined' ? window.location.hash.replace('#/', '') : '') as 'orders' | 'products'; setRoute(h === 'products' ? 'products' : 'orders'); };
    read(); window.addEventListener('hashchange', read); return () => window.removeEventListener('hashchange', read);
  }, []);
  const routeForUI = mounted ? route : 'orders';

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 border-b">
        <div className="mx-auto max-w-[480px] px-4 py-3 flex items-center justify-between gap-2">
          <div className="text-base font-semibold tracking-tight shrink-0">店側アプリ</div>
          <nav className="flex flex-wrap items-center gap-1 gap-y-1 text-sm">
            <a href="#/orders" className={`px-3 py-1.5 rounded-lg border shrink-0 ${routeForUI === 'orders' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`} suppressHydrationWarning>注文管理</a>
            <a href="#/products" className={`px-3 py-1.5 rounded-lg border shrink-0 ${routeForUI === 'products' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`} suppressHydrationWarning>商品管理</a>
          </nav>
        </div>
      </header>
      {routeForUI === 'orders' ? <OrdersPage /> : <ProductsPage />}
    </div>
  );
}
