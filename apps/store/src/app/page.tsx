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
  code: string | null;
  customer: string | null;
  items: OrderItem[] | null;
  total: number | null;
  placed_at: string | null;
  status: OrderStatus;
};

type Order = {
  id: string;
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

// 正規化
function mapOrder(r: OrdersRow): Order {
  return {
    id: String(r.id),
    code: r.code ?? null,
    customer: r.customer ?? "匿名",
    items: Array.isArray(r.items) ? r.items : [],
    total: Number(r.total ?? 0),
    placedAt: r.placed_at ?? new Date().toISOString(),
    status: r.status,
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
    if (!url || !key) return null;
    try { const sb = createClient(url, key); w.__supabase = sb; return sb; } catch { return null; }
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

  const pending = useMemo(() => orders.filter(o => o.status === 'PENDING'), [orders]);
  const fulfilled = useMemo(() => orders.filter(o => o.status === 'FULFILLED'), [orders]);
  return { ready, err, orders, pending, fulfilled, fulfill, retry: fetchAndSubscribe } as const;
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
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
  const { ready, err, pending, fulfilled, fulfill, retry } = useOrders();
  const [current, setCurrent] = useState<Order | null>(null);
  return (
    <main className="mx-auto max-w-4xl px-4 py-5 space-y-8">
      {!ready && (<div className="rounded-xl border bg-white p-4 text-sm text-zinc-600">読み込み中…</div>)}
      {err ? (<div className="rounded-xl border bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between"><span>{err}</span><button onClick={retry} className="rounded-lg bg-red-600 text-white px-3 py-1 text-xs">リトライ</button></div>) : null}
      <section>
        <SectionTitle badge={`${pending.length}件`}>受取待ちの注文</SectionTitle>
        {pending.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">現在、受取待ちの注文はありません。</div>) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{pending.map(o => (<OrderCard key={o.id} order={o} onHandoff={setCurrent} />))}</div>
        )}
      </section>
      <section>
        <SectionTitle badge={`${fulfilled.length}件`}>受け渡し済み</SectionTitle>
        {fulfilled.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">まだ受け渡し済みの注文はありません。</div>) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-90">{fulfilled.map(o => (<OrderCard key={o.id} order={o} onHandoff={() => {}} />))}</div>
        )}
      </section>
      {current && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" onClick={() => setCurrent(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-5" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <div className="text-base font-semibold">コード照合</div>
              <div className="text-sm text-zinc-600">注文ID {current.id} / 顧客 {current.customer}</div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setCurrent(null)} className="rounded-xl border px-4 py-2 text-sm">キャンセル</button>
              <button onClick={() => { fulfill(current.id); setCurrent(null); }} className="rounded-xl bg-zinc-900 text-white px-4 py-2 text-sm">受け渡し</button>
            </div>
          </div>
        </div>
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
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between">
          <div className="text-base font-semibold tracking-tight">店側アプリ</div>
          <nav className="flex items-center gap-2 text-sm">
            <StoreSwitcher />
            <a href="#/orders" className={`px-3 py-1.5 rounded-lg border ${routeForUI === 'orders' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`} suppressHydrationWarning>注文管理</a>
            <a href="#/products" className={`px-3 py-1.5 rounded-lg border ${routeForUI === 'products' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`} suppressHydrationWarning>商品管理</a>
          </nav>
        </div>
      </header>
      {routeForUI === 'orders' ? <OrdersPage /> : <ProductsPage />}
    </div>
  );
}

