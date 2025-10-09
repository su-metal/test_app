"use client";
import React, { useEffect, useMemo, useRef, useState, startTransition, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";




/**
 * ユーザー向けフードロスアプリ（Pilot v2.6 / TS対応）
 * - Toast通知、在庫連動、店舗別会計、簡易テスト決済
 * - 暗黙 any の排除、Props/State 型を明示
 */

// ---- ユーティリティ ----
function useSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    return React.useMemo(
        () => (typeof window === "undefined" ? null : createClient(url, key)),
        [url, key]
    );
}
function pushLog(entry: unknown) {
    try {
        const key = "app_logs";
        const arr = JSON.parse(localStorage.getItem(key) || "[]");
        arr.unshift({ ts: Date.now(), entry });
        localStorage.setItem(key, JSON.stringify(arr.slice(0, 100)));
    } catch {/* noop */ }
}

const fmt = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const currency = (n: number) => fmt.format(n);
const uid = () => Math.random().toString(36).slice(2, 10);
const to6 = (s: string) => (Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0) % 1_000_000).toString().padStart(6, "0");

// ---- Toast（非同期通知） ----
type ToastKind = "info" | "success" | "error";
interface ToastPayload { kind: ToastKind; msg: string }
const emitToast = (kind: ToastKind, msg: string) => {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent<ToastPayload>("app:toast", { detail: { kind, msg } as ToastPayload } as CustomEventInit<ToastPayload>));
    }
};

function ToastBar({ toast, onClose }: { toast: ToastPayload | null; onClose: () => void }) {
    if (!toast) return null;
    const tone = toast.kind === "success" ? "bg-emerald-600" : toast.kind === "error" ? "bg-red-600" : "bg-zinc-800";
    return (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-white rounded-full shadow ${tone}`} role="status" aria-live="polite">
            <div className="flex items-center gap-3">
                <span className="text-sm whitespace-pre-wrap">{toast.msg}</span>
                <button type="button" className="text-xs underline cursor-pointer" onClick={onClose}>閉じる</button>
            </div>
        </div>
    );
}

// クリップボード（クリック起点で呼ぶ。失敗時はフォールバック）
async function safeCopy(text: string) {
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text); return true;
        }
    } catch {/* fallthrough */ }
    try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.pointerEvents = "none";
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        emitToast("error", `コピーできませんでした。手動で選択してください\n${text}`);
        return false;
    }
}

// ---- localStorage 汎用フック ----
function useLocalStorageState<T>(key: string, initial: T | (() => T)) {
    const read = () => {
        try { const v = localStorage.getItem(key); if (v != null) return JSON.parse(v) as T; } catch {/* noop */ }
        return typeof initial === "function" ? (initial as () => T)() : initial;
    };
    const [state, setState] = useState<T>(read);
    useEffect(() => { try { localStorage.setItem(key, JSON.stringify(state)); } catch {/* noop */ } }, [key, state]);
    return [state, setState] as const;
}

// ---- テストカード検証（簡易） ----
function sanitizeCard(input: string) { return input.replace(/\s|-/g, ""); }
function validateTestCard(cardRaw: string) {
    const card = sanitizeCard(cardRaw);
    if (card.length === 0) return { ok: true, brand: "TEST", note: "（未入力はモック成功扱い）" } as const;
    if (!/^\d{16}$/.test(card)) return { ok: false, msg: "カード番号は16桁の数字で入力してください（テスト）" } as const;
    if (card.startsWith("400000")) return { ok: false, msg: "失敗カード（400000…）として扱いました（テスト）" } as const;
    if (card === "4000000000000002") return { ok: false, msg: "一般的なカード拒否（テスト）" } as const;
    if (card.startsWith("4242")) return { ok: true, brand: "Visa(4242)" } as const;
    return { ok: true, brand: "TEST" } as const;
}

// ---- 型 ----
interface Item { id: string; name: string; price: number; stock: number; pickup: string; note: string; photo: string }
interface Shop { id: string; name: string; lat: number; lng: number; zoomOnPin: number; closed: boolean; items: Item[] }
interface CartLine { shopId: string; item: Item; qty: number }
interface Order { id: string; userEmail: string; shopId: string; amount: number; status: "paid" | "redeemed" | "refunded"; code6: string; createdAt: number; lines: CartLine[] }

type ShopWithDistance = Shop & { distance: number };

// ---- 初期データ ----
const seedShops = (): Shop[] => ([
    {
        id: "s1", name: "ベーカリー こむぎ", lat: 35.682, lng: 139.768, zoomOnPin: 16, closed: false, items: [
            { id: "i1", name: "本日のパン詰め合わせ", price: 400, stock: 3, pickup: "18:00-20:00", note: "当日中に", photo: "🥐" },
            { id: "i2", name: "クロワッサン3個", price: 350, stock: 5, pickup: "18:00-20:00", note: "", photo: "🥐" },
        ]
    },
    {
        id: "s2", name: "DELI みどり", lat: 35.679, lng: 139.765, zoomOnPin: 15, closed: false, items: [
            { id: "i3", name: "サラダボウル", price: 500, stock: 4, pickup: "19:00-21:00", note: "", photo: "🥗" },
            { id: "i4", name: "日替わりデリ", price: 600, stock: 2, pickup: "19:00-21:00", note: "", photo: "🍱" },
        ]
    },
    {
        id: "s3", name: "CAFE あおぞら", lat: 35.683, lng: 139.769, zoomOnPin: 17, closed: false, items: [
            { id: "i5", name: "焼き菓子セット", price: 300, stock: 6, pickup: "17:30-19:30", note: "", photo: "🍪" },
        ]
    },
]);

// ---- 共有キー ----
const K = { shops: "shops", cart: "cart", orders: "orders", user: "user_email" } as const;

// ---- ErrorBoundary ----
class MinimalErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean; message?: string }> {
    constructor(props: React.PropsWithChildren) { super(props); this.state = { hasError: false }; }
    static getDerivedStateFromError(err: unknown) { return { hasError: true, message: String((err as any)?.message || err) }; }
    componentDidCatch(error: unknown, info: unknown) { pushLog({ type: "error", message: String((error as any)?.message || error), info }); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center p-6">
                    <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-sm">
                        <div className="font-semibold mb-2">問題が発生しました</div>
                        <div className="text-zinc-600 mb-3">画面を再読み込みしてください。ログは保存されています。</div>
                        <div className="flex gap-2">
                            <button className="px-3 py-2 rounded border cursor-pointer" onClick={() => location.reload()}>再読み込み</button>
                            <button className="px-3 py-2 rounded border cursor-pointer" onClick={async () => { const data = localStorage.getItem("app_logs") || "[]"; const ok = await safeCopy(data); emitToast(ok ? "success" : "error", ok ? "ログをコピーしました" : "ログのコピーに失敗しました"); }}>ログをコピー</button>
                        </div>
                    </div>
                </div>
            );
        }
        return this.props.children as React.ReactNode;
    }
}

export default function UserPilotApp() {
    // 永続化
    const [shops, setShops] = useLocalStorageState<Shop[]>(K.shops, seedShops);
    const [cart, setCart] = useLocalStorageState<CartLine[]>(K.cart, []);
    const [orders, setOrders] = useLocalStorageState<Order[]>(K.orders, []);
    const [userEmail] = useLocalStorageState<string>(K.user, "");

    const [tab, setTab] = useState<"home" | "cart" | "order" | "account">("home");
    const [focusedShop, setFocusedShop] = useState<string | undefined>(undefined);
    const supabase = useSupabase();


    // --- Hydration対策（SSRとクライアント差異を回避） ---
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);

    const [clock, setClock] = useState<string>("");
    useEffect(() => {
        const tick = () => setClock(new Date().toLocaleTimeString());
        tick();
        const id = setInterval(tick, 30_000);
        return () => clearInterval(id);
    }, []);

    // トースト購読
    const [toast, setToast] = useState<ToastPayload | null>(null);
    useEffect(() => {
        let timeoutId: number | undefined;
        const handler = (e: Event) => {
            const ev = e as CustomEvent<ToastPayload>; setToast(ev.detail);
            if (timeoutId) window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(() => setToast(null), 3000);
        };
        window.addEventListener("app:toast", handler as any);

        const onErr = (ev: ErrorEvent) => pushLog({ type: "window.error", message: String(ev.message) });
        const onRej = (ev: PromiseRejectionEvent) => pushLog({ type: "unhandledrejection", message: String((ev.reason as any)?.message || ev.reason) });
        window.addEventListener("error", onErr);
        window.addEventListener("unhandledrejection", onRej);

        return () => {
            window.removeEventListener("app:toast", handler as any);
            window.removeEventListener("error", onErr);
            window.removeEventListener("unhandledrejection", onRej);
            if (timeoutId) window.clearTimeout(timeoutId);
        };
    }, []);

    // 二重決済防止
    const isPayingRef = useRef(false);
    const [isPaying, setIsPaying] = useState(false);

    // 距離はダミー
    const distKm = (i: number) => 0.4 + i * 0.3;
    const shopsSorted = useMemo<ShopWithDistance[]>(() => shops.map((s, i) => ({ ...s, distance: distKm(i) })), [shops]);

    // 参照インデックス
    const shopsById = useMemo(() => {
        const m = new Map<string, Shop>(); for (const s of shops) m.set(s.id, s); return m;
    }, [shops]);
    const itemsById = useMemo(() => {
        const outer = new Map<string, Map<string, Item>>();
        for (const s of shops) { const inner = new Map<string, Item>(); for (const it of s.items) inner.set(it.id, it); outer.set(s.id, inner); }
        return outer;
    }, [shops]);

    // 予約数量（カート数量）
    const reservedMap = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of cart) { const k = `${c.shopId}:${c.item.id}`; m.set(k, (m.get(k) || 0) + c.qty); }
        return m;
    }, [cart]);
    const getReserved = (sid: string, itemId: string) => reservedMap.get(`${sid}:${itemId}`) || 0;

    // 店舗別のカート情報
    const cartByShop = useMemo(() => {
        const g: Record<string, CartLine[]> = {}; for (const l of cart) { (g[l.shopId] ||= []).push(l); } return g;
    }, [cart]);
    const totalsByShop = useMemo(() => {
        const t: Record<string, number> = {}; for (const sid in cartByShop) { t[sid] = cartByShop[sid].reduce((a, l) => a + l.item.price * l.qty, 0); } return t;
    }, [cartByShop]);
    const qtyByShop = useMemo(() => {
        const q: Record<string, number> = {}; for (const sid in cartByShop) { q[sid] = cartByShop[sid].reduce((a, l) => a + l.qty, 0); } return q;
    }, [cartByShop]);
    const shopTotal = (sid: string) => totalsByShop[sid] || 0;

    // 数量変更（±チップと追加ボタン共通）
    const changeQty = (sid: string, it: Item, delta: number) => setCart(cs => {
        const idx = cs.findIndex(c => c.shopId === sid && c.item.id === it.id);
        const cur = idx >= 0 ? cs[idx].qty : 0;
        const next = Math.max(0, Math.min(it.stock, cur + delta));
        if (idx < 0 && next === 0) return cs; // 変更なし
        if (next === 0) return cs.filter((_, i) => i !== idx);
        if (idx < 0) return [...cs, { shopId: sid, item: it, qty: next }];
        const copy = cs.slice(); copy[idx] = { ...cs[idx], qty: next }; return copy;
    });
    const addToCart = (sid: string, it: Item) => changeQty(sid, it, +1);

    // 店舗ごとのカートを空にする
    const clearShopCart = (sid: string) => {
        const count = (cartByShop[sid]?.length ?? 0);
        if (count === 0) { emitToast("info", "この店舗のカートは空です"); return; }
        setCart(cs => cs.filter(l => l.shopId !== sid));
        const name = shopsById.get(sid)?.name || sid;
        emitToast("success", `${name} のカートを空にしました`);
    };

    // 注文処理
    const [cardDigits, setCardDigits] = useState(""); // 数字のみ（最大16桁）
    const [orderTarget, setOrderTarget] = useState<string | undefined>(undefined);
    const toOrder = (sid: string) => { setOrderTarget(sid); setTab("order"); };

    const confirmPay = useCallback(async () => {
        if (!orderTarget || isPayingRef.current || isPaying) return;
        isPayingRef.current = true;
        setIsPaying(true);

        try {
            const sid = orderTarget;

            // カード検証
            const card = validateTestCard(cardDigits);
            if (!card.ok) { emitToast("error", card.msg); return; }

            // 対象店舗のカートをスナップショット
            const linesSnapshot = (cartByShop[sid] || []).map(l => ({ ...l }));
            if (linesSnapshot.length === 0) { emitToast("error", "対象カートが空です"); return; }

            // 在庫検証
            for (const l of linesSnapshot) {
                const inv = itemsById.get(sid)?.get(l.item.id)?.stock ?? 0;
                if (l.qty > inv) {
                    emitToast("error", `在庫不足: ${l.item.name} の在庫は ${inv} です（カート数量 ${l.qty}）`);
                    return;
                }
            }

            // 金額確定
            const amount = linesSnapshot.reduce((a, l) => a + l.item.price * l.qty, 0);
            const oid = uid();

            // Supabase用ペイロード（店舗側は PENDING で受け取り待ち）
            const orderPayload = {
                code: to6(oid),
                customer: userEmail || "guest@example.com",
                items: linesSnapshot.map(l => ({ id: l.item.id, name: l.item.name, qty: l.qty })), // JSONB
                total: amount,
                status: "PENDING" as const,
            };

            // Supabaseが設定されていればDBへ作成
            // Supabaseが設定されていればDBへ作成
            if (supabase) {
                const { data, error } = await supabase
                    .from("orders")
                    .insert(orderPayload)
                    .select("*")
                    .single();

                if (error) {
                    emitToast("error", "注文の作成に失敗しました");
                    return;
                }

                // ★ここを追加：DBに作成した注文と“同じコード”をローカル履歴にも保存する
                const createdAt = Date.now();
                const localOrder: Order = {
                    id: String(data?.id ?? oid),                 // 取得できたらDBのid、なければoid
                    userEmail: userEmail || "guest@example.com",
                    shopId: sid,
                    amount,
                    status: "paid",                               // ユーザー側は「未引換チケット」を paid で扱う既存UIのまま
                    code6: orderPayload.code,                     // ← ここが超重要：DBに入れた code をそのまま使う
                    createdAt,
                    lines: linesSnapshot,
                };
                setOrders(prev => [localOrder, ...prev]);

            } else {
                // Supabase未設定時のフォールバック（従来のローカル動作）
                const localOrder: Order = {
                    id: oid,
                    userEmail: userEmail || "guest@example.com",
                    shopId: sid,
                    amount,
                    status: "paid",
                    code6: orderPayload.code,                     // ← フォールバック時もアルゴリズムを1本化
                    createdAt: Date.now(),
                    lines: linesSnapshot,
                };
                setOrders(prev => [localOrder, ...prev]);
            }


            // 在庫減算＆カートクリア（ローカルUIの整合性のため常に実施）
            const qtyByItemId = new Map<string, number>();
            for (const l of linesSnapshot) {
                qtyByItemId.set(l.item.id, (qtyByItemId.get(l.item.id) || 0) + l.qty);
            }
            const nextShops = shops.map(s =>
                s.id !== sid
                    ? s
                    : {
                        ...s,
                        items: s.items.map(it => {
                            const q = qtyByItemId.get(it.id) || 0;
                            return q > 0 ? { ...it, stock: Math.max(0, it.stock - q) } : it;
                        }),
                    }
            );
            const nextCart = cart.filter(l => l.shopId !== sid);

            startTransition(() => {
                setShops(nextShops);
                setCart(nextCart);
                setTab("account");
            });

            setCardDigits("");
            emitToast("success", `注文が完了しました。カード: ${card.brand || "TEST"}`);
        } finally {
            isPayingRef.current = false;
            setIsPaying(false);
        }
    }, [orderTarget, isPaying, cardDigits, cartByShop, itemsById, shops, cart, userEmail, supabase]);


    // UI 共通
    const Tab = ({ id, label, icon }: { id: "home" | "cart" | "order" | "account"; label: string; icon: string }) => (
        <button onClick={() => setTab(id)} className={`flex-1 py-2 text-center cursor-pointer ${tab === id ? "text-zinc-900 font-semibold" : "text-zinc-500"}`}>
            <div>{icon}</div><div className="text-xs">{label}</div>
        </button>
    );

    const QtyChip = ({ sid, it }: { sid: string; it: Item }) => {
        const reserved = getReserved(sid, it.id);
        const remain = Math.max(0, it.stock - reserved);
        return (
            <div className="mt-2 inline-flex items-center rounded-full border px-2 py-1 text-sm select-none">
                <button type="button" className="px-2 py-0.5 rounded-full border cursor-pointer disabled:opacity-40" disabled={reserved <= 0} onClick={() => changeQty(sid, it, -1)}>−</button>
                <span className="mx-3 min-w-[1.5rem] text-center tabular-nums">{reserved}</span>
                <button type="button" className="px-2 py-0.5 rounded-full border cursor-pointer disabled:opacity-40" disabled={remain <= 0} onClick={() => changeQty(sid, it, +1)}>＋</button>
            </div>
        );
    };

    // SSR時は描画を保留してクライアントで初回描画
    if (!hydrated) return null;

    return (
        <MinimalErrorBoundary>
            <div className="min-h-screen bg-gradient-to-b from-white to-zinc-50">
                <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b">
                    <div className="max-w-[448px] mx-auto px-4 py-3 flex items-center justify-between" suppressHydrationWarning>
                        <h1 className="text-lg font-bold">ユーザーアプリ（Pilot v2.6）</h1>
                        <div className="text-xs text-zinc-500">{clock || "—"}</div>

                    </div>
                </header >

                <main className="max-w-[448px] mx-auto px-4 pb-28">
                    {tab === "home" && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">近くのお店</h2>
                            <div className="rounded-2xl h-40 border bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center text-sm text-zinc-500">（ダミーマップ）ピンをタップして店舗を注目</div>

                            <div className="grid grid-cols-1 gap-3">
                                {shopsSorted.map((s) => {
                                    const visibleItems = s.items.filter(it => { const r = getReserved(s.id, it.id); const remain = Math.max(0, it.stock - r); return it.stock > 0 && (remain > 0 || r > 0); });
                                    const hasAny = visibleItems.length > 0;
                                    const remainingTotal = visibleItems.reduce((a, it) => a + Math.max(0, it.stock - getReserved(s.id, it.id)), 0);
                                    const minPrice = hasAny ? Math.min(...visibleItems.map(it => it.price)) : 0;
                                    const cartCount = qtyByShop[s.id] || 0;
                                    return (
                                        <div key={s.id} className={`relative rounded-2xl border bg-white p-4 ${!hasAny ? 'opacity-70' : ''} ${focusedShop === s.id ? "ring-2 ring-zinc-900" : ""}`}>
                                            {/* ヘッダー */}
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <div className="text-left">
                                                        <div className="text-sm font-semibold truncate">{s.name}</div>
                                                        <div className="text-[11px] text-zinc-500">{s.distance.toFixed(2)} km</div>
                                                    </div>
                                                </div>
                                                <button type="button" className="text-xs px-2 py-1 rounded border cursor-pointer" onClick={() => setFocusedShop(s.id)}>ピン注目</button>
                                            </div>

                                            {/* 詳細 */}
                                            <div className="mt-3 flex items-center justify-between text-sm">
                                                <div className="text-zinc-700">最安 <span className="font-semibold">{hasAny ? currency(minPrice) : '—'}</span></div>
                                                <div className="text-zinc-700">在庫 <span className="tabular-nums font-semibold">{remainingTotal}</span></div>
                                                <div className="text-xs px-2 py-0.5 rounded bg-zinc-100">カート {cartCount}</div>
                                            </div>
                                            {hasAny ? (
                                                <div className="mt-3 grid grid-cols-2 gap-3">
                                                    {visibleItems.map(it => {
                                                        const remain = Math.max(0, it.stock - getReserved(s.id, it.id));
                                                        return (
                                                            <div key={it.id} className={`rounded-xl border p-3`}>
                                                                <div className="text-3xl">{it.photo}</div>
                                                                <div className="text-sm mt-1 font-medium line-clamp-2">{it.name}</div>
                                                                <div className="text-xs text-zinc-500">受取 {it.pickup}</div>
                                                                <div className="flex items-center justify-between mt-2">
                                                                    <div className="text-sm font-semibold">{currency(it.price)}</div>
                                                                    <div className="text-[11px] text-zinc-500">在庫 {remain}</div>
                                                                </div>
                                                                <QtyChip sid={s.id} it={it} />
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="mt-3">
                                                    <div className="rounded-xl border border-dashed p-4 text-center text-sm text-zinc-500 bg-zinc-50">
                                                        {s.items.length === 0 ? '登録商品がありません。' : '現在、販売可能な商品はありません。'}
                                                    </div>
                                                </div>
                                            )}
                                            <div className="mt-3 grid grid-cols-2 gap-2">
                                                <button type="button" className="w-full px-3 py-2 rounded border cursor-pointer disabled:opacity-40" disabled={(qtyByShop[s.id] || 0) === 0} onClick={() => setTab("cart")}>
                                                    カートを見る（{qtyByShop[s.id] || 0}）
                                                </button>
                                                <button type="button" className="w-full px-3 py-2 rounded border cursor-pointer disabled:opacity-40 border-red-500 text-red-600" disabled={(qtyByShop[s.id] || 0) === 0} onClick={() => clearShopCart(s.id)}>
                                                    カートを空にする
                                                </button>
                                            </div>
                                            {!hasAny && (
                                                <div className="pointer-events-none absolute inset-0 rounded-2xl bg-black/5" aria-hidden="true" />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {tab === "cart" && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">カート（店舗別会計）</h2>
                            {Object.keys(cartByShop).length === 0 && <p className="text-sm text-zinc-500">カートは空です</p>}
                            {Object.keys(cartByShop).map(sid => (
                                <div key={sid} className="rounded-2xl border bg-white">
                                    <div className="p-4 border-b flex items-center justify-between">
                                        <div className="text-sm font-semibold">{shopsById.get(sid)?.name || sid}</div>
                                        <div className="text-sm font-semibold">{currency(shopTotal(sid))}</div>
                                    </div>
                                    <div className="p-4 space-y-2">
                                        {(cartByShop[sid] || []).map((l) => (
                                            <div key={`${l.item.id}-${sid}`} className="flex items-center justify-between text-sm">
                                                <div className="truncate">{l.item.name} × {l.qty}</div>
                                                <div className="tabular-nums">{currency(l.item.price * l.qty)}</div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="p-4 border-t">
                                        <button type="button" className="w-full px-3 py-2 rounded bg-zinc-900 text-white cursor-pointer" onClick={() => toOrder(sid)}>注文画面へ</button>
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {tab === "order" && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">注文の最終確認</h2>
                            {!orderTarget && <p className="text-sm text-red-600">対象の店舗カートが見つかりません</p>}
                            {orderTarget && (
                                <div className="rounded-2xl border bg-white">
                                    <div className="p-4 border-b flex items-center justify-between">
                                        <div className="text-sm font-semibold">{shopsById.get(orderTarget)?.name}</div>
                                        <div className="text-sm font-semibold">{currency(shopTotal(orderTarget))}</div>
                                    </div>
                                    <div className="p-4 space-y-2">
                                        {(cartByShop[orderTarget] || []).map((l) => (
                                            <div key={`${l.item.id}-${orderTarget}`} className="text-sm flex items-start justify-between">
                                                <div>
                                                    <div className="font-medium">{l.item.name} × {l.qty}</div>
                                                    <div className="text-xs text-zinc-500">受取 {l.item.pickup} / 注記 {l.item.note || "-"}</div>
                                                </div>
                                                <div className="tabular-nums">{currency(l.item.price * l.qty)}</div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="p-4 border-t space-y-2">
                                        <div className="text-xs text-zinc-500">テスト決済：4242… は成功。400000… は失敗（例：4000 0000 0000 0002）。未入力も成功扱い。</div>
                                        {(() => {
                                            const d = cardDigits.replace(/\D/g, "").slice(0, 16); const formatted = (d.match(/.{1,4}/g)?.join(" ") ?? d); const len = d.length; return (
                                                <>
                                                    <input
                                                        className="w-full px-3 py-2 rounded border font-mono tracking-widest"
                                                        placeholder="4242 4242 4242 4242"
                                                        value={formatted}
                                                        onChange={e => { const nd = e.target.value.replace(/\D/g, "").slice(0, 16); setCardDigits(nd); }}
                                                        inputMode="numeric"
                                                        maxLength={19}
                                                        autoComplete="cc-number"
                                                        aria-label="カード番号（テスト）"
                                                        aria-describedby="card-help"
                                                    />
                                                    <div id="card-help" className="flex items-center justify-between text-[11px] text-zinc-500">
                                                        <span>{len}/16 桁</span>
                                                        <span>4桁ごとに自動スペース</span>
                                                    </div>
                                                    <div className="h-1 bg-zinc-200 rounded">
                                                        <div className="h-1 bg-zinc-900 rounded" style={{ width: `${(len / 16) * 100}%` }} />
                                                    </div>
                                                </>
                                            );
                                        })()}
                                        <button type="button" className="w-full px-3 py-2 rounded border cursor-pointer disabled:opacity-40" onClick={confirmPay} disabled={isPaying || cardDigits.length < 16 || ((cartByShop[orderTarget]?.length ?? 0) === 0)}>注文を確定する（支払い）</button>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    {tab === "account" && (
                        <AccountView orders={orders} shopsById={shopsById} />
                    )}
                </main>

                <footer className="fixed bottom-0 left-0 right-0 border-t bg-white/90">
                    <div className="max-w-[448px] mx-auto grid grid-cols-4 text-center">
                        <Tab id="home" label="ホーム" icon="🏠" />
                        <Tab id="cart" label="カート" icon="🛒" />
                        <Tab id="order" label="注文" icon="🧾" />
                        <Tab id="account" label="アカウント" icon="👤" />
                    </div>
                </footer>

                {/* 規約リンク */}
                <div className="max-w-[448px] mx-auto px-4 py-2 text-center text-[10px] text-zinc-500">
                    <a className="underline cursor-pointer" href="#">利用規約</a> ・ <a className="underline cursor-pointer" href="#">プライバシー</a>
                </div>

                <ToastBar toast={toast} onClose={() => setToast(null)} />
            </div >
        </MinimalErrorBoundary >
    );
}

function TinyQR({ seed }: { seed: string }) {
    const size = 21, dot = 6, pad = 4; let h = Array.from(seed).reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0) >>> 0; const bits: number[] = [];
    for (let i = 0; i < size * size; i++) { h = (1103515245 * h + 12345) >>> 0; bits.push((h >> 15) & 1); }
    const w = size * dot + pad * 2;
    return (
        <svg width={w} height={w} className="rounded bg-white shadow"><rect x={0} y={0} width={w} height={w} fill="white" />{bits.map((b, i) => b ? <rect key={i} x={pad + (i % size) * dot} y={pad + Math.floor(i / size) * dot} width={dot - 1} height={dot - 1} /> : null)}</svg>
    );
}

function AccountView({ orders, shopsById }: { orders: Order[]; shopsById: Map<string, Shop> }) {
    const [refreshTick, setRefreshTick] = useState(0);
    const pending = useMemo(() => orders.filter(o => o.status === "paid").sort((a, b) => b.createdAt - a.createdAt), [orders, refreshTick]);
    const [openTicketId, setOpenTicketId] = useState<string | null>(null);

    // 注文履歴のコンパクト表示
    const sortedOrders = useMemo(() => [...orders].sort((a, b) => b.createdAt - a.createdAt), [orders]);
    const [showAllHistory, setShowAllHistory] = useState(false);
    const MAX_COMPACT = 5;
    const visibleOrders = showAllHistory ? sortedOrders : sortedOrders.slice(0, MAX_COMPACT);
    const remaining = Math.max(0, sortedOrders.length - visibleOrders.length);

    return (
        <section className="mt-4 space-y-4">
            <h2 className="text-base font-semibold">アカウント / チケット</h2>

            {/* 未引換チケット（アコーディオン・QR単一表示） */}
            {pending.length === 0 && (
                <div className="text-sm text-zinc-500">未引換のチケットはありません。</div>
            )}
            {pending.length > 0 && (
                <div className="space-y-3">
                    <div className="text-sm font-semibold flex items-center justify-between">
                        <span>未引換のチケット</span>
                        <button type="button" className="text-[11px] px-2 py-1 rounded border cursor-pointer" onClick={() => { setRefreshTick(t => t + 1); emitToast('info', '最新状態に更新しました'); }}>最新状態に更新</button>
                    </div>
                    {pending.map(o => {
                        const shopName = shopsById.get(o.shopId)?.name || o.shopId;
                        const isOpen = openTicketId === o.id;
                        return (
                            <div key={o.id} className={`rounded-2xl border bg-white ${isOpen ? 'p-4' : 'p-3'}`}>
                                {/* ヘッダー（アコーディオン切替） */}
                                <button type="button" aria-expanded={isOpen} aria-controls={`ticket-${o.id}`} className="w-full flex items-center justify-between cursor-pointer" onClick={() => setOpenTicketId(isOpen ? null : o.id)}>
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-lg leading-none">{isOpen ? '▾' : '▸'}</span>
                                        <div className="text-left truncate">
                                            <div className="text-sm font-semibold truncate">{shopName}</div>
                                            <div className="text-[11px] text-zinc-500 truncate">注文番号 {o.id}</div>
                                        </div>
                                    </div>
                                    <div className="text-xs px-2 py-1 rounded bg-amber-100 shrink-0">状態: paid</div>
                                </button>

                                {/* オープン時のみ詳細描画（QRは常時1枚） */}
                                {isOpen && (
                                    <div id={`ticket-${o.id}`}>
                                        <div className="grid grid-cols-2 gap-4 items-center mt-3">
                                            <div>
                                                <div className="text-xs text-zinc-500">6桁コード</div>
                                                <div className="text-2xl font-mono tracking-widest">{o.code6}</div>
                                                <div className="text-xs text-zinc-500 mt-2">合計</div>
                                                <div className="text-base font-semibold">{currency(o.amount)}</div>
                                                <div className="text-[11px] text-zinc-500 mt-1">{new Date(o.createdAt).toLocaleString()}</div>
                                                <div className="mt-2">
                                                    <button type="button" className="text-xs px-2 py-1 rounded border cursor-pointer" onClick={async () => { const ok = await safeCopy(o.code6); emitToast(ok ? 'success' : 'error', ok ? 'コピーしました' : 'コピーに失敗しました'); }}>コードをコピー</button>
                                                </div>
                                            </div>
                                            <div className="justify-self-center">
                                                <div className="p-2 rounded bg-white shadow"><TinyQR seed={o.id} /></div>
                                            </div>
                                        </div>
                                        <div className="text-xs text-zinc-500 mt-3">※ 店頭で6桁コードまたはQRを提示してください。受取完了は店舗側アプリで行われ、ステータスが <b>redeemed</b> に更新されます。</div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 注文履歴（コンパクト） */}
            <div className="rounded-2xl border bg-white p-4">
                <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">注文履歴</div>
                    <div className="text-[11px] text-zinc-500">{sortedOrders.length}件</div>
                </div>
                <ul className="mt-2 divide-y">
                    {visibleOrders.map(o => (
                        <li key={o.id} className="py-3 flex items-center justify-between text-sm">
                            <div>
                                <div className="font-medium">{o.id}</div>
                                <div className="text-xs text-zinc-500">{new Date(o.createdAt).toLocaleString()} / {o.status}</div>
                            </div>
                            <div className="font-semibold">{currency(o.amount)}</div>
                        </li>
                    ))}
                </ul>
                {remaining > 0 && !showAllHistory && (
                    <div className="pt-3">
                        <button type="button" className="w-full px-3 py-2 rounded border cursor-pointer" onClick={() => setShowAllHistory(true)} aria-expanded={false}>残り{remaining}件を表示</button>
                    </div>
                )}
                {showAllHistory && sortedOrders.length > MAX_COMPACT && (
                    <div className="pt-3">
                        <button type="button" className="w-full px-3 py-2 rounded border cursor-pointer" onClick={() => setShowAllHistory(false)} aria-expanded={true}>先頭{MAX_COMPACT}件だけ表示</button>
                    </div>
                )}
            </div>
        </section>
    );
}
