"use client";
import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

// --- Toast helper（暫定。UIトーストを入れるまでの代替） ---
function emitToast(type: "success" | "error" | "info", message: string) {
  try {
    if (type === "error") console.error(message);
    if (typeof window !== "undefined") {
      // 成功時だけ alert、他はコンソールに出す簡易版
      if (type === "success") alert(message);
    }
  } catch {
    /* noop */
  }
}


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
  main_image_path: string | null;
  sub_image_path1: string | null;
  sub_image_path2: string | null;
};

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  main_image_path: string | null;
  sub_image_path1: string | null;
  sub_image_path2: string | null;
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
function mapProduct(r: ProductsRow): Product {
  return {
    id: String(r.id),
    name: r.name,
    price: Number(r.price ?? 0),
    stock: Math.max(0, Number(r.stock ?? 0)),
    main_image_path: r.main_image_path ?? null,
    sub_image_path1: r.sub_image_path1 ?? null,
    sub_image_path2: r.sub_image_path2 ?? null,
  };
}

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


// --- ここから修正版（匿名ログインはフラグ有効時のみ + 一回限り） ---
function useEnsureAuth() {
  const sb = useSupabase();

  // 一度でも試行したら再実行しない（Strict Mode対策）
  const triedRef = React.useRef(false);

  useEffect(() => {
    (async () => {
      if (!sb || triedRef.current) return;
      triedRef.current = true;

      try {
        // 既にセッションがあれば何もしない
        const { data: { session } } = await sb.auth.getSession();
        if (session) return;

        // 環境変数で匿名ログインを明示的に有効化した場合のみ試行
        const enableAnon =
          (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_ENABLE_ANON_AUTH === "1") ||
          (typeof window !== "undefined" && (window as any).NEXT_PUBLIC_ENABLE_ANON_AUTH === "1");

        if (enableAnon && typeof (sb.auth as any).signInAnonymously === "function") {
          const { error } = await (sb.auth as any).signInAnonymously();
          if (error) {
            // 422などは info ログで握りつぶす（ネットワークエラーを発生させない）
            console.info("[auth] anonymous sign-in skipped:", error.message || error);
          }
        } else {
          // 無効時は何もしない（未ログインのまま）
          console.info("[auth] anonymous auth disabled; skipped sign-in");
        }
      } catch (e) {
        console.info("[auth] ensure auth skipped:", (e as any)?.message ?? e);
      }
    })();
  }, [sb]);
}
// --- ここまで修正版 ---


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
    try { localStorage.setItem('store:selected', v); } catch { }
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

  const updateStock = useCallback(async (id: string, next: number) => {
    const clamped = Math.max(0, Math.floor(Number(next || 0)));
    // 先にローカルへ反映（楽観更新）
    setProducts(prev => prev.map(p => p.id === id ? { ...p, stock: clamped } : p));
    if (!supabase) return;
    const { data, error } = await supabase
      .from('products')
      .update({ stock: clamped })
      .eq('id', id)
      .eq('store_id', getStoreId())
      .select('*')
      .single();
    if (error) {
      setPerr(error.message || '在庫更新に失敗しました');
      // 失敗時は再読込で整合
      await load();
      return;
    }
    if (data) setProducts(prev => prev.map(p => p.id === id ? mapProduct(data as ProductsRow) : p));
  }, [supabase, load]);

  return { products, perr, ploading, add, remove, updateStock, reload: load } as const;
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
    if (data) {
      setOrders(prev => prev.map(o => o.id === String((data as OrdersRow).id) ? mapOrder(data as OrdersRow) : o));
      // 在庫反映のタイミングは「支払い時点」に変更。受け渡し時の減算は行わない。
      // TODO(req v2): 運用上の整合が必要ならサーバー側で冪等化/検証を行う
      orderChan.post({ type: 'ORDER_FULFILLED', orderId: String((data as OrdersRow).id), at: Date.now() });
    }
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
    return () => { try { if (raf) cancelAnimationFrame(raf); } catch { } try { const v = videoRef.current as any; if (v) v.pause?.(); } catch { } try { stream?.getTracks?.().forEach(t => t.stop()); } catch { } };
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

function StockInline({ id, stock, disabled, onCommit }: { id: string; stock: number; disabled: boolean; onCommit: (val: number) => void }) {
  const [val, setVal] = React.useState<string>(() => String(Math.max(0, Math.floor(Number(stock || 0)))));
  React.useEffect(() => { setVal(String(Math.max(0, Math.floor(Number(stock || 0))))); }, [stock]);
  const commit = React.useCallback(() => {
    const n = Math.max(0, Math.floor(Number(val || 0)));
    if (!Number.isFinite(n)) return;
    onCommit(n);
  }, [val, onCommit]);

  return (
    <div className="mt-1 flex items-center justify-end gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        className="w-20 rounded-lg border px-2 py-1 text-xs text-right"
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        aria-label="在庫数"
        disabled={disabled}
      />
      <button type="button" className="inline-flex items-center rounded-lg border px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50" onClick={commit} disabled={disabled}>更新</button>
    </div>
  );
}

// 在庫調整モーダル（数値入力で更新）
function StockAdjustModal({
  open,
  initial,
  productName,
  onClose,
  onCommit,
  disabled,
}: {
  open: boolean;
  initial: number;
  productName: string;
  onClose: () => void;
  onCommit: (val: number) => void;
  disabled: boolean;
}) {
  const [val, setVal] = React.useState<string>(() => String(Math.max(0, Math.floor(Number(initial || 0)))));
  React.useEffect(() => { setVal(String(Math.max(0, Math.floor(Number(initial || 0))))); }, [initial, open]);
  const commit = React.useCallback(() => {
    const n = Math.max(0, Math.floor(Number(val || 0)));
    if (!Number.isFinite(n)) return;
    onCommit(n);
  }, [val, onCommit]);
  // ▼ 反映プレビュー用の計算
  const nextNum = Math.max(0, Math.floor(Number(val || 0)));
  const currentNum = Math.max(0, Math.floor(Number(initial || 0)));
  const diff = nextNum - currentNum;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold mb-1">在庫調整</div>
        <div className="text-sm text-zinc-600 mb-3">対象: {productName}</div>
        <div className="mb-3">
          <div className="text-xs text-zinc-600">数量</div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="text-2xl font-semibold tabular-nums">{val || "0"}</div>
            <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => setVal("0")} disabled={disabled}>0にする</button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 select-none">
            <button type="button" className="h-12 rounded-xl bg-zinc-900 text-white text-lg font-semibold active:opacity-90" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) + 1))))} disabled={disabled}>+1</button>
            <button type="button" className="h-12 rounded-xl bg-zinc-900 text-white text-lg font-semibold active:opacity-90" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) + 5))))} disabled={disabled}>+5</button>
            <button type="button" className="h-12 rounded-xl bg-zinc-900 text-white text-lg font-semibold active:opacity-90" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) + 10))))} disabled={disabled}>+10</button>

            <button type="button" className="h-12 rounded-xl bg-zinc-100 text-zinc-900 text-lg font-medium active:opacity-80" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) - 1))))} disabled={disabled}>-1</button>
            <button type="button" className="h-12 rounded-xl bg-zinc-100 text-zinc-900 text-lg font-medium active:opacity-80" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) - 5))))} disabled={disabled}>-5</button>
            <button type="button" className="h-12 rounded-xl bg-zinc-100 text-zinc-900 text-lg font-medium active:opacity-80" onClick={() => setVal(v => String(Math.max(0, (Number(v || 0) - 10))))} disabled={disabled}>-10</button>
          </div>
          <label className="mt-3 block text-sm">
            <span className="text-zinc-700">直接入力</span>
            <input type="number" inputMode="numeric" min={0} step={1} className="mt-1 w-full rounded-xl border px-3 py-3 text-base text-right" value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} aria-label="在庫数" disabled={disabled} />
          </label>
          {/* ▼ 反映プレビュー：調整前 → 調整後（±差） */}
          {/* ▼ 反映プレビュー（強調）：調整前 → 調整後（±差） */}
          <div
            className={
              `mt-3 rounded-xl border px-4 py-3 tabular-nums relative overflow-hidden
               ${diff === 0
                ? 'bg-zinc-50 border-zinc-200'
                : diff > 0
                  ? 'bg-emerald-50/80 border-emerald-300 ring-1 ring-emerald-300'
                  : 'bg-red-50/80 border-red-300 ring-1 ring-red-300'}`
            }
          >
            {/* 左端のアクセントバー */}
            <div
              className={`absolute inset-y-0 left-0 w-1
                ${diff === 0 ? 'bg-zinc-200' : diff > 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <div className="pl-3">
              <div className="pl-3">
                <div
                  className={`text-[11px] uppercase tracking-wide ${diff === 0 ? 'text-zinc-500' : diff > 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                >
                  PREVIEW
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  ...

                  <span className="text-lg font-semibold">{currentNum}</span>
                  <span className="text-base">→</span>
                  <span className="text-2xl font-extrabold">{nextNum}</span>
                  <span
                    className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold
                    ${diff === 0
                        ? 'bg-zinc-200 text-zinc-700'
                        : diff > 0
                          ? 'bg-emerald-600 text-white'
                          : 'bg-red-600 text-white'}`}
                    aria-label="差分"
                  >
                    {diff > 0 ? '＋' : diff < 0 ? '－' : '±'}{Math.abs(diff)}
                  </span>
                </div>
                {diff !== 0 && (
                  <div className={`mt-1 text-[12px] ${diff > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {diff > 0 ? '在庫を増やします' : '在庫を減らします'}
                  </div>
                )}
              </div>
            </div>

          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button onClick={onClose} className="rounded-xl border px-4 py-3 text-sm">キャンセル</button>
            <button onClick={commit} disabled={disabled} className={`rounded-xl px-4 py-3 text-sm text-white ${disabled ? "bg-zinc-400 cursor-not-allowed" : "bg-zinc-900"}`}>更新</button>
          </div>
        </div>
      </div >
      );
    </div >
  )
}


function useImageUpload() {
  const supabase = useSupabase();

  type Slot = "main" | "sub1" | "sub2";
  const colOf = (slot: Slot) =>
    slot === "main" ? "main_image_path" :
      slot === "sub1" ? "sub_image_path1" : "sub_image_path2";

  const uploadProductImage = useCallback(async (productId: string, file: File, slot: Slot) => {
    if (!supabase) throw new Error("Supabase 未初期化");

    // 事前に store_id と既存パスを取得（安全性＆旧ファイル掃除）
    const { data: before, error: fetchErr } = await supabase
      .from("products")
      .select("store_id, main_image_path, sub_image_path1, sub_image_path2")
      .eq("id", productId)
      .single();
    if (fetchErr) throw fetchErr;

    const sid = getStoreId();
    if (!before) throw new Error("対象商品が存在しません");
    if (!sid) throw new Error("店舗IDが未設定です（NEXT_PUBLIC_STORE_ID）");
    if (String(before.store_id ?? "") !== String(sid)) {
      throw new Error("他店舗の商品は更新できません");
    }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `products/${productId}/${slot}-${Date.now()}.${ext}`;

    // 1) Storage へアップロード
    const up = await supabase.storage.from("public-images").upload(path, file, {
      cacheControl: "3600",
      upsert: true,
    });
    if (up.error) {
      console.error("[upload] storage error", up.error);
      throw up.error;
    }

    // 2) DB を更新（更新する列だけ差し替え、store_id で二重限定）
    const col = colOf(slot);
    const upd = await supabase
      .from("products")
      .update({ [col]: path })
      .eq("id", productId)
      .eq("store_id", sid);
    if (upd.error) {
      console.error("[upload] db error", upd.error);
      await supabase.storage.from("public-images").remove([path]).catch(() => { });
      throw upd.error;
    }

    // 3) 旧ファイル掃除（該当スロットのみ）
    const oldPath =
      slot === "main" ? before.main_image_path :
        slot === "sub1" ? before.sub_image_path1 : before.sub_image_path2;
    if (oldPath && oldPath !== path) {
      await supabase.storage.from("public-images").remove([oldPath]).catch(() => { });
    }

    return path;
  }, [supabase]);

  return { uploadProductImage };
}




function ProductForm() {
  useEnsureAuth(); // ★ 追加：匿名ログインで authenticated を確保
  const { products, perr, ploading, add, remove, updateStock, reload } = useProducts();
  // ★ 画像のキャッシュ破り用バージョン
  const [imgVer, setImgVer] = useState(0);
  const [adjust, setAdjust] = useState<null | { id: string; name: string; stock: number }>(null);
  const [pending, setPending] = useState<Record<string, { id: string; name: string; current: number; next: number }>>({});
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("");
  const take = storeTake(Number(price || 0));
  const { uploadProductImage } = useImageUpload();
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  // ▼▼ ギャラリー（モーダル）用 state
  const [gallery, setGallery] = useState<null | {
    id: string;
    name: string;
    paths: string[]; // [main, sub1, sub2] の有効なものだけを詰める
  }>(null);
  const [gIndex, setGIndex] = useState(0);
  // ▼ 未反映の合計差分（バッジ表示用）
  const totalDelta = useMemo(() => {
    const list = Object.values(pending);
    const sum = list.reduce((acc, it) => acc + (it.next - it.current), 0);
    return { sum, count: list.length };
  }, [pending]);


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
      <div className="grid grid-cols-1 gap-3">
        {products.map((p) => {
          return (
            <div key={p.id} className="rounded-2xl border bg-white shadow-sm overflow-hidden">
              {/* ヘッダー：商品名 + 在庫チップ（価格は下段に移動） */}
              <div className="px-4 pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div
                      className="text-[15px] font-semibold leading-tight line-clamp-2 break-words"
                      title={p.name}
                    >
                      {p.name}
                    </div>
                    {/* 在庫チップ（視認性アップ） */}
                    <div className="mt-1">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border
          ${p.stock > 5
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : p.stock > 0
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-zinc-100 text-zinc-500 border-zinc-200'
                        }`}>
                        のこり {p.stock} 個
                      </span>
                    </div>
                    {/* ▼ その商品の未反映内容がある場合だけ、前→後（±差）をカード上でも表示 */}
                    {/* ▼ この商品の未反映差分（強調チップ） */}
                    {pending[p.id] ? (() => {
                      const it = pending[p.id];
                      const diff = it.next - it.current;
                      const chipTone =
                        diff === 0 ? 'bg-zinc-200 text-zinc-800'
                          : diff > 0 ? 'bg-emerald-600 text-white'
                            : 'bg-red-600 text-white';
                      return (
                        <div className="mt-1 flex items-center gap-1 text-[12px] tabular-nums">
                          <span className="text-zinc-600">未反映:</span>
                          <span className="font-medium">{it.current}</span>
                          <span>→</span>
                          <span className="font-semibold">{it.next}</span>
                          <span className={`ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] ${chipTone}`}>
                            {diff > 0 ? '＋' : diff < 0 ? '－' : '±'}{Math.abs(diff)}
                          </span>
                        </div>
                      );
                    })() : null}

                  </div>
                  {/* 右側は空ける（価格表示は下段へ移動） */}
                  <div className="shrink-0" />
                </div>
              </div>

              {/* 3枚サムネ（メイン/サブ1/サブ2）— スマホで列幅にフィット */}
              <div className="px-4 py-3">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { slot: "main" as const, label: "メイン", path: p.main_image_path },
                    { slot: "sub1" as const, label: "サブ1", path: p.sub_image_path1 },
                    { slot: "sub2" as const, label: "サブ2", path: p.sub_image_path2 },
                  ].map(({ slot, label, path }) => {
                    const inputId = `product-image-${p.id}-${slot}`;
                    return (
                      <div key={slot} className="flex flex-col items-center w-full">
                        <input
                          id={inputId}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={async (e) => {
                            const inputEl = e.currentTarget as HTMLInputElement | null;
                            const file = inputEl?.files?.[0];
                            if (!file) return;
                            try {
                              setUploadingId(p.id);
                              await uploadProductImage(p.id, file, slot);
                              await reload();
                              setImgVer((v) => v + 1);
                              alert(`${label}画像を更新しました`);
                            } catch (err: any) {
                              alert(`アップロードに失敗しました: ${err?.message ?? err}`);
                            } finally {
                              setUploadingId(null);
                              if (inputEl) inputEl.value = "";
                            }
                          }}
                          disabled={ploading || uploadingId === p.id}
                        />
                        <label
                          htmlFor={inputId}
                          className="relative block w-full aspect-square overflow-hidden rounded-xl border bg-zinc-50 cursor-pointer group"
                          aria-label={`${p.name} の${label}画像をアップロード/変更`}
                          title={`${label}をタップしてアップロード/変更`}
                        >
                          {path ? (
                            <img
                              src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${path}?v=${imgVer ?? 0}`}
                              alt={`${p.name} ${label}`}
                              className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="w-full h-full grid place-items-center text-[11px] text-zinc-500">
                              画像なし
                              <div className="text-[10px] mt-0.5">タップで追加</div>
                            </div>
                          )}
                          <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-black/5" />
                          {uploadingId === p.id && (
                            <div className="absolute inset-0 grid place-items-center text-xs bg-white/70">
                              更新中…
                            </div>
                          )}
                          {path && (
                            <span className="pointer-events-none absolute bottom-1 right-1 text-[10px] px-1 rounded bg-white/85 shadow-sm opacity-0 group-hover:opacity-100">
                              変更
                            </span>
                          )}
                        </label>
                        <div className="mt-1 text-[10px] text-zinc-600">{label}</div>
                      </div>
                    );
                  })}
                </div>
              </div>


              {/* 操作ボタン列（視認性＆押しやすさUP） */}
              {/* 操作＆金額（左=ボタン / 右=価格・店側受取） */}
              <div className="px-4 pb-4">
                <div className="flex items-center justify-between gap-3">
                  {/* 左：操作ボタンを左寄せ */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAdjust({ id: p.id, name: p.name, stock: p.stock })}
                      className="px-3 py-2 rounded-lg border text-sm hover:bg-zinc-50"
                    >
                      在庫調整
                    </button>

                    <button
                      onClick={async () => {
                        if (!confirm(`「${p.name}」を削除しますか？`)) return;
                        try { await remove(p.id); }
                        catch (e: any) { alert(`削除に失敗しました: ${e?.message ?? e}`); }
                      }}
                      className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm hover:bg-red-100"
                    >
                      削除
                    </button>
                  </div>

                  {/* 右：価格・店側受取（強調表示） */}
                  <div className="text-right shrink-0">
                    <div className="text-2xl font-bold leading-none tabular-nums">{yen(p.price)}</div>
                    <div className="text-[11px] text-zinc-500 mt-1">店側受取 {yen(storeTake(p.price))}</div>
                  </div>
                </div>
              </div>

            </div>
          );
        })}
      </div>


      {Object.keys(pending).length > 0 && (
        <div
          className={`sticky bottom-4 mt-4 rounded-2xl border p-3 shadow-lg backdrop-blur
            ${totalDelta.sum === 0
              ? 'bg-white/95 border-zinc-200'
              : totalDelta.sum > 0
                ? 'bg-emerald-50/90 border-emerald-300 ring-1 ring-emerald-300'
                : 'bg-red-50/90 border-red-300 ring-1 ring-red-300'}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">未反映の在庫変更</div>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-900 text-white">
                {totalDelta.count} 件
              </span>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-semibold tabular-nums
                  ${totalDelta.sum === 0
                    ? 'bg-zinc-200 text-zinc-800'
                    : totalDelta.sum > 0
                      ? 'bg-emerald-600 text-white'
                      : 'bg-red-600 text-white'}`}
                title="合計差分"
              >
                {totalDelta.sum > 0 ? '＋' : totalDelta.sum < 0 ? '－' : '±'}{Math.abs(totalDelta.sum)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border px-3 py-1.5 text-sm bg-white hover:bg-zinc-50"
                onClick={() => setPending({})}
                disabled={ploading}
              >
                すべて取消
              </button>
              <button
                className={`rounded-xl text-white px-3 py-1.5 text-sm disabled:opacity-50
                  ${totalDelta.sum >= 0 ? 'bg-zinc-900' : 'bg-zinc-900'}`}
                disabled={ploading}
                onClick={async () => {
                  const items = Object.values(pending);
                  for (const it of items) {
                    await updateStock(it.id, it.next);
                  }
                  setPending({});
                }}
              >
                在庫を反映する
              </button>
            </div>
          </div>

          {/* ▼ 一覧（行ごとに色分け＆目立つバッジ） */}
          <ul className="mt-2 space-y-1">
            {Object.values(pending).map((it) => {
              const diff = it.next - it.current;
              const diffAbs = Math.abs(diff);
              const rowTone =
                diff === 0 ? 'bg-white border-zinc-200'
                  : diff > 0 ? 'bg-white border-emerald-200'
                    : 'bg-white border-red-200';
              const chipTone =
                diff === 0 ? 'bg-zinc-200 text-zinc-800'
                  : diff > 0 ? 'bg-emerald-600 text-white'
                    : 'bg-red-600 text-white';
              return (
                <li key={it.id}
                  className={`flex items-center justify-between text-sm rounded-xl border px-3 py-2 ${rowTone}`}>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{it.name}</div>
                    <div className="text-xs text-zinc-600 tabular-nums">
                      {it.current} → <span className="font-semibold">{it.next}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${chipTone}`}>
                      {diff > 0 ? '＋' : diff < 0 ? '－' : '±'}{diffAbs}
                    </span>
                    <button
                      className="text-xs rounded-lg border px-2 py-1 bg-white hover:bg-zinc-50"
                      onClick={() => {
                        setPending(prev => {
                          const { [it.id]: _omit, ...rest } = prev;
                          return rest;
                        });
                      }}
                    >
                      取り消し
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}


      {/* ▼ 在庫調整モーダルをここで描画 */}
      <StockAdjustModal
        open={!!adjust}
        initial={adjust?.stock ?? 0}
        productName={adjust?.name ?? ""}
        disabled={ploading}
        onClose={() => setAdjust(null)}
        onCommit={(val) => {
          if (!adjust) return;
          setPending(prev => ({
            ...prev,
            [adjust.id]: {
              id: adjust.id,
              name: adjust.name,
              current: adjust.stock,
              next: Math.max(0, Math.floor(Number(val || 0))),
            },
          }));
          setAdjust(null);
          emitToast('info', '未反映の在庫変更に追加しました');
        }}
      />


    </div>
  )
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
    <main className="mx-auto max-w-[448px] px-4 py-5 space-y-6">
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
          <div className="grid grid-cols-1 gap-4 opacity-90">{fulfilled.map(o => (<OrderCard key={o.id} order={o} onHandoff={() => { }} />))}</div>
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

function ProductsPage() {
  return (
    <main className="mx-auto max-w-[448px] px-4 py-5 space-y-8">
      <ProductForm />
      <div className="text-xs text-zinc-500">※ 商品管理は単一ページとして暫定運用。ブックマーク例: <code>#/products</code></div>
    </main>
  );
}


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
        <div className="mx-auto max-w-[448px] px-4 py-3 flex items-center justify-between gap-2">
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
