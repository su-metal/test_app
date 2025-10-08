"use client";
import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

// v3.2 TS対応版：暗黙any/Window拡張/Ref型/Props型の修正、警告抑制なしでビルド可

// ===== 型定義 =====
type OrderStatus = "PENDING" | "FULFILLED";

type OrderItem = {
    id: string;
    name: string;
    qty: number;
};

type OrdersRow = {
    id: string;
    code: string;
    customer: string | null;
    items: OrderItem[] | null;
    total: number | null;
    placed_at: string | null;
    status: OrderStatus;
};

type Order = {
    id: string;
    code: string;
    customer: string;
    items: OrderItem[];
    total: number;
    placedAt: string;
    status: OrderStatus;
};

type ProductsRow = {
    id: string;
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

// Window 拡張（環境変数を window 越しに参照するため）
declare global {
    interface Window {
        NEXT_PUBLIC_SUPABASE_URL?: string;
        __SUPABASE_URL__?: string;
        NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
        __SUPABASE_ANON_KEY__?: string;
        __STORE_ID__?: string;
        BarcodeDetector?: any;
    }
}

// ===== 正規化 =====
function mapOrder(r: OrdersRow): Order {
    return {
        id: String(r.id),
        code: r.code,
        customer: r.customer ?? "匿名",
        items: Array.isArray(r.items) ? r.items : [],
        total: Number(r.total ?? 0),
        placedAt: r.placed_at ?? new Date().toISOString(),
        status: r.status,
    };
}

function mapProduct(r: ProductsRow): Product {
    return {
        id: String(r.id),
        name: r.name,
        price: Number(r.price ?? 0),
        stock: Number(r.stock ?? 0),
    };
}

// ===== Mock =====
const mockOrders: Order[] = [
    { id: "ord_24001", code: "A7C2-9K", customer: "山田様", items: [{ id: "p1", name: "救済パンBOX", qty: 1 }, { id: "p2", name: "野菜ミックス", qty: 1 }], total: 540, placedAt: new Date(Date.now() - 1_500_000).toISOString(), status: "PENDING" },
    { id: "ord_24002", code: "Q4M8-2T", customer: "佐藤様", items: [{ id: "p3", name: "ラストケーキ", qty: 2 }], total: 800, placedAt: new Date(Date.now() - 3_600_000).toISOString(), status: "PENDING" },
    { id: "ord_23991", code: "Z1X9-0B", customer: "匿名", items: [{ id: "p4", name: "お惣菜セット", qty: 1 }], total: 450, placedAt: new Date(Date.now() - 7_200_000).toISOString(), status: "FULFILLED" },
];

const mockProducts: Product[] = [{ id: "p1", name: "救済パンBOX", price: 400, stock: 5 }];

// ===== Utils =====
const yen = (n: number) => n.toLocaleString("ja-JP", { style: "currency", currency: "JPY" });
const since = (iso: string) => { const d = Date.now() - new Date(iso).getTime(); const m = Math.floor(d / 60000); if (m < 1) return "たった今"; if (m < 60) return `${m}分前`; return `${Math.floor(m / 60)}時間前`; };
const storeTake = (price: number | string) => Math.floor(Number(price || 0) * 0.8);

// ===== Clients =====
function useSupabase() {
    const url = (typeof process !== 'undefined' && (process.env?.NEXT_PUBLIC_SUPABASE_URL as string | undefined)) || (typeof window !== 'undefined' && (window.NEXT_PUBLIC_SUPABASE_URL || window.__SUPABASE_URL__)) || undefined;
    const key = (typeof process !== 'undefined' && (process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined)) || (typeof window !== 'undefined' && (window.NEXT_PUBLIC_SUPABASE_ANON_KEY || window.__SUPABASE_ANON_KEY__)) || undefined;
    return useMemo(() => { if (typeof window === 'undefined' || !url || !key) return null; try { return createClient(url, key); } catch { return null; } }, [url, key]);
}

function useBroadcast(name: string) {
    const chan = useMemo(() => { if (typeof window === 'undefined') return null; try { return new BroadcastChannel(name); } catch { return null; } }, [name]);
    const post = (payload: unknown) => { try { (chan as BroadcastChannel | null)?.postMessage(payload as any); } catch { } };
    useEffect(() => () => { try { (chan as BroadcastChannel | null)?.close(); } catch { } }, [chan]);
    return { post } as const;
}

// ===== Data: Products =====
function useProducts() {
    const supabase = useSupabase();
    const [products, setProducts] = useState<Product[]>(mockProducts);
    const [perr, setPerr] = useState<string | null>(null);
    const [ploading, setPloading] = useState(false);
    const invChan = useBroadcast('inventory-sync');

    const load = useCallback(async () => {
        if (!supabase) return; setPloading(true); setPerr(null);
        const { data, error } = await supabase.from('products').select('*').order('updated_at', { ascending: false });
        if (error) setPerr(error.message || '商品取得に失敗'); else if (Array.isArray(data)) setProducts((data as ProductsRow[]).map(mapProduct));
        setPloading(false);
    }, [supabase]);
    useEffect(() => { load(); }, [load]);

    const add = useCallback(async (payload: { name: string; price: number; stock: number; }) => {
        if (!payload.name) { setPerr('商品名は必須'); return; }
        if (!supabase) { const np: Product = { id: Math.random().toString(36).slice(2), ...payload }; setProducts(prev => [np, ...prev]); return; }
        setPloading(true); setPerr(null);
        const { data, error } = await supabase.from('products').insert({ name: payload.name, price: payload.price, stock: payload.stock }).select('*').single();
        if (error) setPerr(error.message || '商品登録に失敗'); else if (data) setProducts(prev => [mapProduct(data as ProductsRow), ...prev]);
        setPloading(false);
    }, [supabase]);

    // 受け渡し後の在庫減算を購読
    useEffect(() => {
        const onMsg = (e: MessageEvent) => {
            const m = e.data as any; if (!m || m.type !== 'DECREMENT_STOCK') return;
            setProducts(prev => {
                const map = new Map(prev.map(p => [p.id, { ...p }]));
                (m.items as { id: string; qty: number }[]).forEach(({ id, qty }) => { const p = map.get(id); if (p) { p.stock = Math.max(0, (p.stock || 0) - qty); map.set(id, p); } });
                return Array.from(map.values());
            });
        };
        const ch = new BroadcastChannel('inventory-sync'); ch.onmessage = onMsg; return () => { try { ch.close(); } catch { } };
    }, []);

    return { products, perr, ploading, add, reload: load, invChan } as const;
}

// ===== Data: Orders（在庫減算を内包） =====
function useOrders() {
    const supabase = useSupabase();
    const { invChan } = useProducts();
    const orderChan = useBroadcast('order-sync');

    const [orders, setOrders] = useState<Order[]>(mockOrders);
    const [ready, setReady] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const channelRef = useRef<RealtimeChannel | null>(null);
    const storeId = (typeof process !== 'undefined' && (process.env?.NEXT_PUBLIC_STORE_ID as string | undefined)) || (typeof window !== 'undefined' && window.__STORE_ID__) || 'default';
    const chanName = `orders-realtime-${storeId}`;

    const cleanup = useCallback(() => {
        try { channelRef.current?.unsubscribe?.(); } catch { }
        try { if (supabase && channelRef.current) (supabase as any).removeChannel(channelRef.current); } catch { }
        channelRef.current = null;
    }, [supabase]);

    const fetchAndSubscribe = useCallback(async () => {
        if (!supabase) { setReady(true); return; } setErr(null); cleanup();
        const { data, error } = await supabase.from('orders').select('*').order('placed_at', { ascending: false });
        if (error) setErr(error.message || 'データ取得に失敗しました'); else if (Array.isArray(data)) setOrders((data as OrdersRow[]).map(mapOrder));
        try {
            const ch = (supabase as any)
                .channel(chanName)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (p: any) => { if (p?.new) setOrders(prev => [mapOrder(p.new as OrdersRow), ...prev]); })
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, (p: any) => { if (p?.new) setOrders(prev => prev.map(o => o.id === String((p.new as OrdersRow).id) ? mapOrder(p.new as OrdersRow) : o)); })
                .subscribe() as RealtimeChannel;
            channelRef.current = ch;
        } catch { setErr('リアルタイム購読に失敗しました'); }
        setReady(true);
    }, [supabase, chanName, cleanup]);

    useEffect(() => { fetchAndSubscribe(); return () => { cleanup(); }; }, [fetchAndSubscribe, cleanup]);
    const retry = useCallback(() => { setReady(false); fetchAndSubscribe(); }, [fetchAndSubscribe]);

    // 在庫減算（DB→Broadcast）
    const decrementStocksDB = useCallback(async (items: OrderItem[]) => {
        if (!supabase) { // mock
            invChan.post({ type: 'DECREMENT_STOCK', items: items.map(({ id, qty }) => ({ id, qty })) });
            return;
        }
        await Promise.all(items.map(async (it) => {
            const { data: prod } = await supabase.from('products').select('id,stock').eq('id', it.id).single();
            if (prod) { const next = Math.max(0, Number((prod as any).stock || 0) - it.qty); await supabase.from('products').update({ stock: next }).eq('id', it.id); }
        }));
        invChan.post({ type: 'DECREMENT_STOCK', items: items.map(({ id, qty }) => ({ id, qty })) });
    }, [supabase, invChan]);

    const fulfill = useCallback((id: string) => {
        const target = orders.find(o => o.id === id);
        if (!target) { return; }
        if (!supabase) {
            setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'FULFILLED' } : o));
            decrementStocksDB(target.items);
            orderChan.post({ type: 'ORDER_FULFILLED', orderId: id, at: Date.now() });
            return;
        }
        return supabase.from('orders').update({ status: 'FULFILLED' }).eq('id', id).select('*').single().then(async ({ data, error }) => {
            if (error) { setErr(error.message || '更新に失敗しました'); return; }
            if (data) { setOrders(prev => prev.map(o => o.id === String((data as OrdersRow).id) ? mapOrder(data as OrdersRow) : o)); await decrementStocksDB(target.items); orderChan.post({ type: 'ORDER_FULFILLED', orderId: String((data as OrdersRow).id), at: Date.now() }); }
        });
    }, [supabase, orders, decrementStocksDB, orderChan]);

    const pending = useMemo(() => orders.filter(o => o.status === 'PENDING'), [orders]);
    const fulfilled = useMemo(() => orders.filter(o => o.status === 'FULFILLED'), [orders]);
    return { ready, err, orders, pending, fulfilled, fulfill, retry } as const;
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
                <span className="text-zinc-500">受付: {since(order.placedAt)}</span>
                <span className="font-semibold">{yen(order.total)}</span>
            </div>
            {order.status === 'PENDING' ? (
                <button onClick={onClick} className="w-full rounded-xl bg-zinc-900 text-white py-2.5 text-sm font-medium hover:bg-zinc-800 active:opacity-90">引換する（コード照合）</button>
            ) : (
                <div className="w-full rounded-xl bg-emerald-600/10 text-emerald-700 py-2.5 text-sm text-center font-medium">受け渡し完了</div>
            )}
        </div>
    );
});

function QRScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void; }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => {
        let stream: MediaStream | undefined; let raf: number | undefined; let detector: any;
        async function start() {
            try {
                const supports = 'BarcodeDetector' in window;
                if (supports) detector = new window.BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128'] });
                stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                const v = videoRef.current; if (!v) return; (v as any).srcObject = stream; await v.play();
                if (detector) {
                    const loop = async () => { try { const codes = await detector.detect(v); if (codes && codes[0]) { onDetect(codes[0].rawValue || codes[0].rawValueText || ''); stop(); } } catch { } raf = requestAnimationFrame(loop); };
                    raf = requestAnimationFrame(loop);
                }
            } catch (e) { setErr('カメラにアクセスできません'); }
        }
        function stop() { try { stream?.getTracks()?.forEach((t) => t.stop()); } catch { } try { if (raf) cancelAnimationFrame(raf); } catch { } onClose && onClose(); }
        start();
        return () => { try { stream?.getTracks()?.forEach((t) => t.stop()); } catch { } try { if (raf) cancelAnimationFrame(raf); } catch { } };
    }, [onDetect, onClose]);
    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-2xl bg-black p-3 text-white space-y-2">
                <div className="text-sm">QRを枠内に合わせてください</div>
                <video ref={videoRef} className="w-full aspect-[3/4] rounded-xl bg-black" muted playsInline />
                {err ? <div className="text-xs text-red-300">{err}</div> : null}
                <button onClick={onClose} className="w-full rounded-xl bg-white/10 py-2 text-sm">閉じる</button>
            </div>
        </div>
    );
}

function HandoffDialog({ order, onClose, onFulfill }: { order: Order | null; onClose: () => void; onFulfill: (id: string) => any; }) {
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [scan, setScan] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { if (order) { setInput(""); setError(null); requestAnimationFrame(() => { try { inputRef.current?.focus(); } catch { } }); } }, [order]);
    useEffect(() => { if (!order) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [order, onClose]);
    if (!order) return null;
    const check = () => { const normalized = input.trim().toUpperCase(); if (!normalized) { setError('コードを入力してください'); return; } setSubmitting(true); if (normalized === String(order.code).toUpperCase()) { const maybe = onFulfill(order.id); onClose(); if (maybe?.then) (maybe as Promise<any>).finally(() => setSubmitting(false)); else setSubmitting(false); } else { setError('コードが一致しません'); setSubmitting(false); } };
    const titleId = 'handoff-title', descId = 'handoff-desc';
    return (
        <div ref={overlayRef} className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
            <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-5" onMouseDown={(e) => e.stopPropagation()}>
                <div className="mb-3">
                    <div id={titleId} className="text-base font-semibold">コード照合</div>
                    <div className="text-sm text-zinc-600">注文ID {order.id}（{order.customer}）</div>
                </div>
                <div id={descId} className="mb-3 text-sm text-zinc-700">引換コードを入力するか、QRを読み取ってください。</div>
                <div className="flex gap-2 mb-2">
                    <input id="redeem-code" ref={inputRef} className="flex-1 rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900" placeholder="例: A7C2-9K" value={input} onChange={(e) => setInput(e.target.value)} />
                    <button onClick={() => setScan(true)} className="rounded-xl border px-3 py-2 text-sm">カメラ</button>
                </div>
                {error ? <p className="mt-1 text-sm text-red-600" role="alert">{error}</p> : null}
                <div className="mt-4 flex items-center justify-end gap-2">
                    <button onClick={onClose} className="rounded-xl border px-4 py-2 text-sm hover:bg-zinc-50" disabled={submitting}>キャンセル</button>
                    <button onClick={check} className="rounded-xl bg-zinc-900 text-white px-4 py-2 text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed" disabled={submitting}>{submitting ? '処理中…' : '照合して受け渡し'}</button>
                </div>
            </div>
            {scan && (
                <QRScanner onDetect={(code) => { setInput(code); setScan(false); }} onClose={() => setScan(false)} />
            )}
        </div>
    );
}

function ProductForm() {
    const { products, perr, ploading, add, reload } = useProducts();
    const [name, setName] = useState(""); const [price, setPrice] = useState(""); const [stock, setStock] = useState("");
    const take = storeTake(price);
    const onSubmit = async (e: React.FormEvent) => { e.preventDefault(); await add({ name: name.trim(), price: Number(price || 0), stock: Number(stock || 0) }); setName(""); setPrice(""); setStock(""); };
    return (
        <div className="rounded-2xl border bg-white p-4 space-y-4">
            <div className="flex items-center justify-between"><div className="text-base font-semibold">商品登録</div><button onClick={reload} className="text-xs rounded-lg border px-2 py-1">再読込</button></div>
            <form onSubmit={onSubmit} className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <input className="rounded-xl border px-3 py-2 text-sm" placeholder="商品名" value={name} onChange={e => setName(e.target.value)} required />
                <input className="rounded-xl border px-3 py-2 text-sm" placeholder="価格" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value)} />
                <input className="rounded-xl border px-3 py-2 text-sm" placeholder="在庫" inputMode="numeric" value={stock} onChange={e => setStock(e.target.value)} />
                <input className="rounded-xl border px-3 py-2 text-sm bg-zinc-50" value={`店舗受取額 ${yen(take)}`} readOnly aria-label="店舗受取額" />
                <button className="rounded-xl bg-zinc-900 text-white px-3 py-2 text-sm" disabled={ploading}>追加</button>
            </form>
            {perr ? <div className="text-sm text-red-600">{perr}</div> : null}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {products.map(p => (
                    <div key={p.id} className="rounded-xl border p-3 text-sm flex items-center justify-between">
                        <div className="space-y-0.5">
                            <div className="font-medium">{p.name}</div>
                            <div className="text-zinc-600 text-xs">店舗受取額 {yen(storeTake(p.price))}</div>
                        </div>
                        <div className="text-right">
                            <div className="font-semibold">{yen(p.price)}</div>
                            <div className="text-xs text-zinc-500">在庫 {p.stock}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function StoreApp() {
    const [route, setRoute] = useState<string>(() => {
        if (typeof window !== 'undefined') { const h = window.location.hash.replace('#/', ''); return (h as string) || 'orders'; }
        return 'orders';
    });
    useEffect(() => {
        const onHash = () => { const h = window.location.hash.replace('#/', '') || 'orders'; setRoute(h); };
        window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
    }, []);

    return (
        <div className="min-h-screen bg-zinc-50">
            <header className="sticky top-0 z-40 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 border-b">
                <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between">
                    <div className="text-base font-semibold tracking-tight">店舗アプリ</div>
                    <nav className="flex items-center gap-2 text-sm">
                        <a href="#/orders" className={`px-3 py-1.5 rounded-lg border ${route === 'orders' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`}>注文管理</a>
                        <a href="#/products" className={`px-3 py-1.5 rounded-lg border ${route === 'products' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`}>商品管理</a>
                    </nav>
                </div>
            </header>

            {route === 'orders' ? <OrdersPage /> : <ProductsPage />}
        </div>
    );
}

function OrdersPage() {
    const { ready, err, pending, fulfilled, fulfill, retry } = useOrders();
    const [current, setCurrent] = useState<Order | null>(null); const onHandoff = useCallback((o: Order) => setCurrent(o), []);
    return (
        <main className="mx-auto max-w-4xl px-4 py-5 space-y-8">
            {!ready && (<div className="rounded-xl border bg-white p-4 text-sm text-zinc-600">読み込み中…</div>)}
            {err ? (<div className="rounded-xl border bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between"><span>{err}</span><button onClick={retry} className="rounded-lg bg-red-600 text-white px-3 py-1 text-xs">リトライ</button></div>) : null}
            <section>
                <SectionTitle badge={`${pending.length}件`}>受取待ちの注文</SectionTitle>
                {pending.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">現在、受け取り待ちの注文はありません。</div>) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{pending.map((o) => (<OrderCard key={o.id} order={o} onHandoff={onHandoff} />))}</div>
                )}
            </section>
            <section>
                <SectionTitle badge={`${fulfilled.length}件`}>受け渡し済み</SectionTitle>
                {fulfilled.length === 0 ? (<div className="rounded-xl border bg-white p-6 text-sm text-zinc-600">まだ受け渡し済みの履歴はありません。</div>) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-90">{fulfilled.map((o) => (<OrderCard key={o.id} order={o} onHandoff={onHandoff} />))}</div>
                )}
            </section>
            <HandoffDialog order={current} onClose={() => setCurrent(null)} onFulfill={fulfill} />
        </main>
    );
}

function ProductsPage() {
    return (
        <main className="mx-auto max-w-4xl px-4 py-5 space-y-8">
            <ProductForm />
            <div className="text-xs text-zinc-500">※ 商品管理は別タブ/別ページとして独立しています。ブックマーク推奨: <code>#/products</code></div>
        </main>
    );
}

// Dev tests (簡易)
function runDevTests() {
    try {
        const rowFull: OrdersRow = { id: "x", code: "ABC", customer: "c", items: [{ id: "p1", name: "n", qty: 1 }], total: 123, placed_at: "2020-01-01T00:00:00Z", status: "PENDING" };
        const rowNulls: OrdersRow = { id: "y", code: "DEF", customer: null, items: null, total: null, placed_at: null, status: "FULFILLED" };
        const o1 = mapOrder(rowFull); console.assert(o1.customer === "c" && o1.items.length === 1 && o1.total === 123, 'mapRow full failed');
        const o2 = mapOrder(rowNulls); console.assert(o2.customer === "匿名" && Array.isArray(o2.items) && o2.items.length === 0 && o2.total === 0, 'mapRow nulls failed');
        console.info('✅ Dev tests passed');
    } catch (e) { console.warn('⚠️ Dev tests error:', e); }
}
if (typeof window !== 'undefined' && (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production')) { runDevTests(); }
