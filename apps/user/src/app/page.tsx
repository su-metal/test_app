"use client";
import React, { useEffect, useMemo, useRef, useState, startTransition, useCallback } from "react";
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import 'leaflet/dist/leaflet.css';
import dynamic from "next/dynamic";
// 追加：受取時間の表示コンポーネント
import PickupTimeSelector, { type PickupSlot } from "@/components/PickupTimeSelector";

// page.tsx より抜粋（MapViewの使用部分）
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

// ===== debug switch =====
const DEBUG = (process.env.NEXT_PUBLIC_DEBUG === '1');

// === REST: orders へ確実に Authorization を付けて INSERT する ===
const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// === REST: orders を確実に DELETE する（apikey + Authorization を強制付与） ===
async function restDeleteOrdersByIds(ids: string[]) {
    const idsCsv = ids.map(String).join(',');
    const url = `${API_URL}/rest/v1/orders?id=in.(${encodeURIComponent(idsCsv)})`;

    const res = await fetch(url, {
        method: 'DELETE',
        headers: {
            apikey: ANON,
            Authorization: `Bearer ${ANON}`,
            // Prefer は無くて OK（DELETE は通常 204 No Content）
        },
    });

    if (res.status === 401) throw new Error('HTTP 401 Unauthorized');
    if (res.status === 403) throw new Error('HTTP 403 Forbidden');
    if (res.status === 404) return; // 対象なしは無視
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} :: ${t}`);
    }
}


async function restInsertOrder(orderPayload: any) {
    const url = `${API_URL}/rest/v1/orders?select=*`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            apikey: ANON,
            Authorization: `Bearer ${ANON}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
        },
        body: JSON.stringify(orderPayload),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt}`);
    }
    return res.json();
}

let __sb__: SupabaseClient | null = null;
function getSupabaseSingleton() {
    if (!__sb__) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

        __sb__ = createClient(url, anon, {
            auth: { storageKey: 'sb-user-app' },
            // ✅ supabase-js 経由の全リクエストに常に鍵を付ける
            global: {
                headers: {
                    apikey: anon,
                    Authorization: `Bearer ${anon}`,
                },
            },
        });
    }
    return __sb__;
}


if (DEBUG && typeof window !== "undefined") {
    console.info("[diag] ANON head =", (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").slice(0, 12));
    console.info("[diag] URL  head =", (process.env.NEXT_PUBLIC_SUPABASE_URL || "").slice(0, 20));
}
/**
 * ユーザー向けフードロスアプリ（Pilot v2.6 / TS対応）
 * - Toast通知、在庫連動、店舗別会計、簡易テスト決済
 * - 暗黙 any の排除、Props/State 型を明示
 */

// ---- ユーティリティ ----
function useSupabase() {
    return useMemo(getSupabaseSingleton, []);
}

// --- remain chip (store-appと同一トーン) ---
const toneByRemain = (n: number) =>
    n > 5
        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : n > 0
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : "bg-zinc-100 text-zinc-500 border-zinc-200";

function RemainChip({ remain, className = "" }: { remain: number; className?: string }) {
    return (
        <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${toneByRemain(remain)} ${className}`}
        >
            のこり <span className="tabular-nums ml-0.5 mr-0.5">{remain}</span> 個
        </span>
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
// 現在時刻（JST, 分）を返す
const nowMinutesJST = () => {
    const parts = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(new Date());
    const hh = Number(parts.find(p => p.type === "hour")?.value || "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value || "0");
    return hh * 60 + mm;
};

const LEAD_CUTOFF_MIN = 20; // 受け取り開始の何分前まで不可にするか（UI全体の既定）

const uid = () => Math.random().toString(36).slice(2, 10);
const to6 = (s: string) => (Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0) % 1_000_000).toString().padStart(6, "0");

// 入力正規化: トリム + 記号除去 + 大文字化（英数字のみ残す）
const norm = (v: unknown): string => {
    const s = (v ?? "").toString();
    return s.trim().replace(/[\s_-]/g, "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
};

// 6桁コード専用: 数字のみ抽出し、左ゼロ埋めで6桁に揃える
const normalizeCode6 = (v: unknown): string => {
    const digits = String(v ?? "").replace(/\D/g, "");
    if (digits.length === 6) return digits;
    if (digits.length < 6) return digits.padStart(6, '0');
    // 6桁より長い場合は比較に使わない（不一致扱い）
    return digits;
};

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

// 背景スクロールをロック（<html>に適用：iOS対策）
function useLockBodyScroll(locked: boolean) {
    useEffect(() => {
        const el = document.documentElement; // <html>
        const prevOverflow = el.style.overflow;
        const prevPaddingRight = el.style.paddingRight;

        if (locked) {
            // スクロールバー分のズレ防止（必要な場合のみ）
            const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
            el.style.overflow = "hidden";
            if (scrollbarW > 0) el.style.paddingRight = `${scrollbarW}px`;
        }
        return () => {
            el.style.overflow = prevOverflow;
            el.style.paddingRight = prevPaddingRight;
        };
    }, [locked]);
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


// === Supabase REST 直叩きユーティリティ（重複排除・本番用） ===
/**
 * orders の軽量取得（idリストで in 検索）
 * - 401 は Error.status = 401 を付けて throw（ポーリング側で停止できるように）
 * - apikey は ヘッダー と URL クエリの両方に付与（環境依存の揺れ対策）
 */
async function getOrderLite(idsCsv: string) {
    if (!API_URL || !ANON) {
        const e: any = new Error("MISSING_ENV");
        e.status = 401; // ポーリング側で401扱いにして止められるように
        throw e;
    }

    const url =
        `${API_URL}/rest/v1/orders` +
        `?select=id,code,status` +
        `&id=in.(${idsCsv})` +
        `&apikey=${encodeURIComponent(ANON)}`;   // ← URL側にも付ける（保険）


    const res = await fetch(url, {
        headers: {
            apikey: ANON,                          // ← ヘッダーにも付与（本命）
            Authorization: `Bearer ${ANON}`,
        },
        cache: "no-store",
    });

    if (res.status === 401) {
        const e: any = new Error("UNAUTHORIZED");
        e.status = 401;
        throw e;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return res.json() as Promise<Array<{ id: string; code: string | null; status?: string | null }>>;
}





// ---- 型 ----
interface Item {
    id: string;
    name: string;
    price: number;
    stock: number;
    pickup: string;
    note: string;
    photo: string;
    main_image_path?: string | null;
    sub_image_path1?: string | null;
    sub_image_path2?: string | null;
}

interface Shop { id: string; name: string; lat: number; lng: number; zoomOnPin: number; closed: boolean; items: Item[], address?: string; cover_image_path?: string | null; }
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


// 店舗カードが完全に画面外に出たら onLeave を発火するラッパー
function CardObserver({
    observe,
    onLeave,
    children,
}: {
    observe: boolean;              // 監視するか（詳細が開いているときだけ true）
    onLeave: () => void;           // カードが画面外に出た時のコールバック（= 閉じる）
    children: React.ReactNode;     // 店舗カードの中身（既存のカード丸ごと）
}) {
    const ref = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!observe || !ref.current) return;

        const el = ref.current;
        const io = new IntersectionObserver(
            (entries) => {
                const e = entries[0];
                // 1pxでも見えていれば isIntersecting = true
                // 完全に画面外に出た瞬間だけ false になる
                if (!e.isIntersecting) onLeave();
            },
            { root: null, threshold: 0 }
        );

        io.observe(el);
        return () => io.disconnect();
    }, [observe, onLeave]);

    return <div ref={ref}>{children}</div>;
}


// 丸いピン（スクショ寄せ・塗りつぶし）
const IconMapPin = ({ className = "" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
        <path
            d="M12 22s7-5.33 7-12a7 7 0 1 0-14 0c0 6.67 7 12 7 12z"
            fill="currentColor"
        />
        <circle cx="12" cy="10" r="2.8" fill="#fff" />
    </svg>
);

// 斜め矢印（外部リンク）
const IconExternal = ({ className = "" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
        <path
            d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"
            fill="currentColor"
        />
        <path
            d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"
            fill="currentColor"
            opacity=".35"
        />
    </svg>
);



export default function UserPilotApp() {

    // 永続化
    const [shops, setShops] = useLocalStorageState<Shop[]>(K.shops, seedShops);
    const [cart, setCart] = useLocalStorageState<CartLine[]>(K.cart, []);
    const [orders, setOrders] = useLocalStorageState<Order[]>(K.orders, []);
    const [pickupByShop, setPickupByShop] = useState<Record<string, PickupSlot | null>>({});

    const [userEmail] = useLocalStorageState<string>(K.user, "");
    const [tab, setTab] = useState<"home" | "cart" | "order" | "account">("home");
    // タブの直前値を覚えておく
    const prevTabRef = useRef<typeof tab>(tab);

    // タブが変わったら実行（cart → それ以外 になった時にだけ掃除）
    useEffect(() => {
        const prev = prevTabRef.current;
        if (prev === 'cart' && tab !== 'cart') {
            setCart(cs => cs.filter(l => l.qty > 0));
        }
        prevTabRef.current = tab;
    }, [tab, setCart]);
    const [focusedShop, setFocusedShop] = useState<string | undefined>(undefined);
    const [detail, setDetail] = useState<{ shopId: string; item: Item } | null>(null);
    useLockBodyScroll(!!detail); // ← 追加：モーダル開閉に連動してスクロール停止
    const detailImages = useMemo<string[]>(() => {
        if (!detail?.item) return [];
        return [
            detail.item.main_image_path,
            detail.item.sub_image_path1,
            detail.item.sub_image_path2,
        ].filter((x): x is string => !!x);
    }, [detail]);
    const supabase = useSupabase();
    type DbProduct = { id: string; store_id?: string; name: string; price?: number; stock?: number; image_url?: string; updated_at?: string };
    type DbStore = { id: string; name: string; created_at?: string; lat?: number; lng?: number; address?: string; cover_image_path?: string | null };

    const [dbProducts, setDbProducts] = useState<DbProduct[]>([]);
    const [dbStores, setDbStores] = useState<DbStore[]>([]);
    // ギャラリー（モーダル）state
    const [gallery, setGallery] = useState<null | { name: string; paths: string[] }>(null);
    const [gIndex, setGIndex] = useState(0);



    // --- Hydration対策（SSRとクライアント差異を回避） ---
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);
    // モーダル: Esc で閉じる
    useEffect(() => {
        if (!detail) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [detail]);
    // 画像を開くたびに先頭へ
    useEffect(() => { if (detail) setGIndex(0); }, [detail, setGIndex]);

    const [clock, setClock] = useState<string>("");
    useEffect(() => {
        const tick = () => setClock(new Date().toLocaleTimeString());
        tick();
        const id = setInterval(tick, 30_000);
        return () => clearInterval(id);
    }, []);

    // Googleマップの遷移先URLを生成（lat/lng優先、なければ住所）
    const googleMapsUrlForShop = (s: Shop) => {
        const hasLL = typeof s.lat === "number" && typeof s.lng === "number";
        if (hasLL) return `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
        if (s.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`;
        return "https://www.google.com/maps";
    };

    // DBから products を読む（全店舗分を取得し、後段で store_id ごとにグルーピング）
    useEffect(() => {
        if (!supabase) return;
        (async () => {
            const q = supabase
                .from("products").select("*, main_image_path, sub_image_path1, sub_image_path2")


            // 必要なら在庫>0や公開フラグで絞ってOK（例）
            // .gt("stock", 0).eq("is_published", true)

            const { data, error } = await q.limit(200);

            console.log("[products:list]", { data, error });
            // ...
            if (error) {
                console.error("[products:list] error", error);
                emitToast("error", `商品取得に失敗: ${error.message}`);
                setDbProducts([]);
            } else {
                setDbProducts(data ?? []);
            }
        })();
    }, [supabase]);



    // products の Realtime 反映（全店舗対象。後段のグルーピングで store_id ごとに整理）
    useEffect(() => {
        if (!supabase) return;
        try {
            const ch = (supabase as any)
                .channel(`products-realtime-all`)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'products' }, (p: any) => {
                    const row = p?.new; if (!row) return;
                    setDbProducts(prev => [row, ...prev.filter(x => String(x.id) !== String(row.id))]);
                })
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'products' }, (p: any) => {
                    const row = p?.new; if (!row) return;
                    setDbProducts(prev => prev.map(x => String(x.id) === String(row.id) ? row : x));
                })
                .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'products' }, (p: any) => {
                    const row = p?.old; if (!row) return;
                    setDbProducts(prev => prev.filter(x => String(x.id) !== String(row.id)));
                })
                .on(
                    'postgres_changes',
                    { event: 'DELETE', schema: 'public', table: 'orders' },
                    (payload: any) => {
                        const old = payload?.old || {};
                        const delId = String(old?.id ?? '');
                        const delCode6 = normalizeCode6(old?.code);
                        setOrders(prev =>
                            prev.filter(o =>
                                String(o.id) !== delId && normalizeCode6(o.code6) !== delCode6
                            )
                        );
                    }
                )

                .subscribe();
            return () => { try { (supabase as any).removeChannel(ch); } catch { } };
        } catch {
            /* noop */
        }
    }, [supabase]);





    // DBから stores を読む（全件・上限あり）
    useEffect(() => {
        if (!supabase) return;
        (async () => {
            const { data, error } = await supabase
                .from("stores")
                .select("id, name, created_at, lat, lng, address, cover_image_path")
                .order("created_at", { ascending: true })
                .limit(200);
            if (error) {
                console.error("[stores:list] error", error);
                emitToast("error", `店舗の取得に失敗しました: ${error.message}`);
                setDbStores([]);
            } else {
                setDbStores(data ?? []);
            }
        })();
    }, [supabase]);

    // DBの stores/products があれば、それを shops に反映（完全DB由来へ）
    useEffect(() => {
        if (!Array.isArray(dbStores) || dbStores.length === 0) return;
        const byStore = new Map<string, DbProduct[]>();
        for (const p of dbProducts) {
            const sid = String(p?.store_id ?? "");
            if (!byStore.has(sid)) byStore.set(sid, []);
            byStore.get(sid)!.push(p);
        }
        const mapToItem = (p: any): Item => {
            const rawStock = (p?.stock ?? p?.quantity ?? p?.stock_count ?? 0);
            const stock = Math.max(0, Number(rawStock) || 0);

            // ★ サムネは main → sub1 → sub2 の優先順
            const primary =
                p?.main_image_path ??
                p?.sub_image_path1 ??
                p?.sub_image_path2 ??
                null;

            return {
                id: String(p.id),
                name: String(p.name ?? "不明"),
                price: Math.max(0, Number(p.price ?? 0) || 0),
                stock,
                pickup: "18:00-20:00",
                note: "",
                photo: "🛍️",
                main_image_path: p?.main_image_path ?? null,
                sub_image_path1: p?.sub_image_path1 ?? null,
                sub_image_path2: p?.sub_image_path2 ?? null,
            };
        };


        const fallback = { lat: 35.171, lng: 136.881 }; // 名古屋駅など任意
        const built: Shop[] = dbStores.map((st) => ({
            id: String(st.id),
            name: String(st.name ?? "店舗"),
            lat: typeof st.lat === "number" ? st.lat : fallback.lat,
            lng: typeof st.lng === "number" ? st.lng : fallback.lng,
            zoomOnPin: 16,
            closed: false,
            items: (byStore.get(String(st.id)) || []).map(mapToItem),
            address: typeof st.address === "string" ? st.address : undefined,
            cover_image_path: st.cover_image_path ?? null,
        }));

        setShops(prev => (JSON.stringify(prev) === JSON.stringify(built) ? prev : built));
    }, [dbStores, dbProducts, setShops]);

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
    const storeId = process.env.NEXT_PUBLIC_STORE_ID;

    // 店舗側で orders.status が更新されたらローカルの注文を同期（未引換→履歴へ）
    useEffect(() => {
        if (!supabase) return;

        // DB → ローカルのステータス変換
        // DB → ローカルのステータス変換（PENDING/PAID 以外はすべて引換済み扱い）
        const toLocalStatus = (dbStatus?: string): Order["status"] => {
            const s = String(dbStatus || "").toUpperCase();
            if (s === "FULFILLED" || s === "REDEEMED" || s === "COMPLETED") return "redeemed"; // ← ここに FULFILLED が含まれていること
            if (s === "PAID" || s === "PENDING") return "paid";
            return "paid";
        };


        // コードでひも付け（code は注文作成時に orderPayload.code として保存済み＝ local の code6）
        const channel = supabase
            .channel("orders-updates")
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "orders" },
                (payload) => {
                    console.log('[realtime:orders][UPDATE]', payload.new);
                    const row: any = payload.new || {};
                    // ★ 完全一致：トリム/大文字化/記号除去などは一切しない
                    const codeDB = row?.code != null ? String(row.code) : "";
                    const idDB = row?.id ? String(row.id) : "";
                    const codeNorm6 = normalizeCode6(codeDB);

                    const next: Order["status"] = (() => {
                        const s = String(row?.status || '').toUpperCase();
                        if (s === 'FULFILLED' || s === 'REDEEMED' || s === 'COMPLETED') return 'redeemed';
                        if (s === 'PAID' || s === 'PENDING') return 'paid';
                        return 'paid';
                    })();

                    let touched = false;
                    setOrders(prev => {
                        // 1) 更新：code(大文字) or id でヒットしたものを書き換え
                        const mapped = prev.map(o => {
                            const oc = normalizeCode6(o.code6);  // 6桁コードを正規化して比較
                            const byCode = (codeNorm6.length === 6 && oc.length === 6) ? (oc === codeNorm6) : false;

                            const byId = idDB ? (String(o.id) === idDB) : false;
                            return (byCode || byId) ? { ...o, status: next } : o;
                        });

                        // 2) 同一 code6 を重複除去（大文字キーで、redeemed を優先）
                        const seen = new Map<string, Order>();
                        for (const o of mapped) {
                            const k = String(o.code6 ?? "");
                            const ex = seen.get(k);
                            if (!ex) {
                                seen.set(k, o);
                            } else {
                                if (ex.status === 'redeemed' && o.status !== 'redeemed') {
                                    // 既存(履歴)を優先
                                } else if (o.status === 'redeemed' && ex.status !== 'redeemed') {
                                    // 今回が履歴なら置換
                                    seen.set(k, o);
                                } else {
                                    // 同格なら先勝ち
                                }
                            }
                        }
                        const dedup = Array.from(seen.values());

                        touched = JSON.stringify(prev) !== JSON.stringify(dedup);
                        return dedup;
                    });

                    if (touched && next === 'redeemed') {
                        setTab('account');
                        emitToast('success', '引換完了：チケットを履歴へ移動しました');
                    }
                }
            )
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [supabase, setOrders, setTab]);

    // 受け渡し済みになっても消えない場合のフェールセーフ: 定期ポーリングで同期
    const pendingKey = useMemo(() => {
        try { return JSON.stringify(orders.filter(o => o.status === 'paid').map(o => ({ id: o.id, code6: o.code6 }))); } catch { return ""; }
    }, [orders]);

    // ★ 多重起動を避けるために useRef で 1本管理
    const pollRef = useRef<number | null>(null);

    useEffect(() => {
        const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
        const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

        // 前回の interval が残っていたら必ず止める
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }

        // 前提が揃ってなければ起動しない
        const targets = orders.filter(o => o.status === "paid");
        if (!API_URL || !ANON || !targets.length) return;

        // 画面が非表示/オフラインなら動かさない（無駄＆ログ抑制）
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        if (typeof navigator !== "undefined" && !navigator.onLine) return;

        const toLocal = (dbStatus?: string): Order["status"] => {
            const s = String(dbStatus || "").toUpperCase();
            if (s === "FULFILLED" || s === "REDEEMED" || s === "COMPLETED") return "redeemed";
            if (s === "PAID" || s === "PENDING") return "paid";
            return "paid";
        };

        let stopped = false; // 401 などで停止したら二度と回さない
        const idsCsv = targets.map(o => String(o.id)).join(",");

        const tick = async () => {
            if (stopped) return;
            try {
                const rows = await getOrderLite(idsCsv); // ← ヘッダー付REST
                setOrders(prev => {
                    let changed = false;

                    // 既存の「ヒットしたら status を同期」部分
                    const next = prev.map(o => {
                        const hit = rows.find(r =>
                            String(r.id) === String(o.id) ||
                            (normalizeCode6(r.code) === normalizeCode6(o.code6))
                        );
                        if (!hit) return o;
                        const ns = toLocal(hit.status || undefined);
                        if (ns !== o.status) { changed = true; return { ...o, status: ns }; }
                        return o;
                    });

                    // ★ここを追加：DB から消えている paid を間引く
                    const liveIds = new Set(rows.map(r => String(r.id)));
                    const liveCodes = new Set(rows.map(r => normalizeCode6(r.code)));
                    const pruned = next.filter(o => {
                        if (o.status !== 'paid') return true; // 履歴(redeemed)はそのまま
                        const hasId = liveIds.has(String(o.id));
                        const hasCode = liveCodes.has(normalizeCode6(o.code6));
                        if (!hasId && !hasCode) { changed = true; return false; }
                        return true;
                    });

                    return changed ? pruned : prev;
                });

            } catch (err: any) {
                // 401 を検知したら停止（雪だるま防止）
                if (err?.status === 401 || err?.message === "UNAUTHORIZED") {
                    if (DEBUG) console.warn("[orders poll] 401 Unauthorized detected. Stop polling.");
                    stopped = true;
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                    return;
                }
                if (DEBUG) console.warn("[orders poll] exception:", err);
            }
        };

        // 即時 + 周期（タブが可視かつオンライン時のみ実行）
        tick();
        pollRef.current = window.setInterval(() => {
            if (document.visibilityState === "visible" && navigator.onLine) tick();
        }, 4000);

        // cleanup
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        };
    }, [pendingKey]); // ← 依存はこのキーだけ（orders丸ごとは不可）



    useEffect(() => {
        console.log('[diag] ANON head =', (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').slice(0, 12));
        console.log('[diag] URL  head =', (process.env.NEXT_PUBLIC_SUPABASE_URL || '').slice(0, 20));
    }, []);


    // DBの商品が取れていて storeId が指定されていれば、その店舗の items を DB で差し替え
    const shopsWithDb = useMemo(() => {
        // すでに DB 由来の shops を反映している場合はそのまま返す
        if (Array.isArray(dbStores) && dbStores.length > 0) return shops;
        if (!Array.isArray(dbProducts) || dbProducts.length === 0 || !storeId) return shops;

        const mapToItem = (p: any): Item => {
            // stock / quantity / stock_count のどれかが入っている想定
            const rawStock = (p?.stock ?? p?.quantity ?? p?.stock_count ?? 0);
            const stock = Math.max(0, Number(rawStock) || 0);

            return {
                id: String(p.id),
                name: String(p.name ?? "商品"),
                price: Math.max(0, Number(p.price ?? 0) || 0),
                stock,
                pickup: "18:00-20:00",
                note: "",
                photo: "🛍️",
            };
        };


        // shops[].id が UUID でない（ローカルID）場合のフォールバック：最初のショップに適用
        const idx = shops.findIndex(s => String(s.id) === String(storeId));
        const targetIndex = idx >= 0 ? idx : 0;

        return shops.map((s, i) =>
            i === targetIndex ? { ...s, items: dbProducts.map(mapToItem) } : s
        );

    }, [shops, dbProducts, storeId, dbStores]);

    const shopsSorted = useMemo<ShopWithDistance[]>(
        () => shopsWithDb.map((s, i) => ({ ...s, distance: distKm(i) })),
        [shopsWithDb]
    );


    // 参照インデックス
    const shopsById = useMemo(() => {
        const m = new Map<string, Shop>();
        for (const s of shopsWithDb) m.set(s.id, s);
        return m;
    }, [shopsWithDb]);

    const itemsById = useMemo(() => {
        const outer = new Map<string, Map<string, Item>>();
        for (const s of shopsWithDb) {
            const inner = new Map<string, Item>();
            for (const it of s.items) inner.set(it.id, it);
            outer.set(s.id, inner);
        }
        return outer;
    }, [shopsWithDb]);


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
    // 置き換え（以前の changeQty をこの実装に）
    const changeQty = (sid: string, it: Item, delta: number) => setCart(cs => {
        const idx = cs.findIndex(c => c.shopId === sid && c.item.id === it.id);
        const cur = idx >= 0 ? cs[idx].qty : 0;
        const next = Math.max(0, Math.min(it.stock, cur + delta));

        if (idx < 0 && next === 0) return cs;                 // 0を新規追加はしない（現状維持）
        if (idx < 0) return [...cs, { shopId: sid, item: it, qty: next }];

        // ← ここがポイント：0 でも行を残す
        const copy = cs.slice();
        copy[idx] = { ...cs[idx], qty: next };
        return copy;
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

    // 全店舗分のカートを一括クリア
    const clearAllCarts = () => {
        if (!(typeof window !== 'undefined' && window.confirm('すべてのカートを空にしますか？'))) return;
        if (cart.length === 0) { emitToast('info', 'カートはすでに空です'); return; }
        setCart([]);
        emitToast('success', 'すべてのカートを空にしました');
    };

    // 未引換チケットを一括リセット（DBとローカルを同期）
    const devResetOrdersStrict = useCallback(async () => {
        if (!confirm('未引換のチケットをすべてリセットします。よろしいですか？')) return;
        try {
            const targetIds = orders.filter(o => o.status === 'paid').map(o => o.id);
            if (targetIds.length === 0) { emitToast('info', '未引換のチケットはありません'); return; }
            if (supabase) {
                const { error } = await supabase.from('orders').delete().in('id', targetIds);
                if (error) {
                    console.error('[orders.reset] error', error);
                    emitToast('error', `リセットに失敗しました: ${error.message}`);
                    return;
                }
            }
            setOrders(prev => prev.filter(o => o.status !== 'paid'));
            emitToast('success', '未引換のチケットをリセットしました');
        } catch (e) {
            console.error('[orders.reset] exception', e);
            emitToast('error', `エラー: ${(e as any)?.message ?? e}`);
        }
    }, [supabase, orders, setOrders]);

    // 注文履歴のみを一括リセット（ローカル優先、可能ならDBも削除）
    const devResetOrderHistory = useCallback(async () => {
        try {
            // 対象IDを組み立て（あなたの既存ロジックを使ってOK）
            const ids = orders
                .filter(o => ['redeemed', 'paid', 'completed'].includes(String(o.status)))
                .map(o => String(o.id));

            if (!ids.length) {
                if (DEBUG) console.info('[orders.resetHistory] skip: no ids');
                return;
            }

            // ★REST 直叩き（必ず apikey / Authorization を付与）
            await restDeleteOrdersByIds(ids);

            const codeKeys = new Set(
                orders
                    .filter(o => ['redeemed', 'paid', 'completed'].includes(String(o.status)))
                    .map(o => normalizeCode6(o.code6))
            );
            setOrders(prev =>
                prev.filter(o =>
                    !ids.includes(String(o.id)) &&
                    !codeKeys.has(normalizeCode6(o.code6))
                )
            );

            if (DEBUG) console.info('[orders.resetHistory] done:', ids.length);
        } catch (e: any) {
            console.error('[orders.resetHistory] error', e?.message || e);
            emitToast('error', '履歴のリセットに失敗しました');
        }
    }, [orders]);


    // 注文処理
    const [cardDigits, setCardDigits] = useState(""); // 数字のみ（最大16桁）
    const [orderTarget, setOrderTarget] = useState<string | undefined>(undefined);
    const [paymentMethod, setPaymentMethod] = useState<"card" | "paypay">("card"); // 支払方法（テスト）
    const unredeemedOrders = useMemo(() => orders.filter(o => o.status === 'paid'), [orders]);
    const redeemedOrders = useMemo(() => orders.filter(o => o.status === 'redeemed'), [orders]);

    // 注文ステータス表示テキスト
    const statusText = (s: Order["status"]) => (
        s === 'redeemed' ? '引換済み' : s === 'paid' ? '未引換' : s === 'refunded' ? '返金済み' : s
    );

    // 引換えタブ向け：code6で正規化・重複排除し、redeemed優先の正規形を作成
    const canonicalOrdersForOrderTab = useMemo(() => {
        const byCode = new Map<string, Order>();
        for (const o of orders) {
            const k = String(o.code6 ?? "");
            const ex = byCode.get(k);
            if (!ex) {
                byCode.set(k, o);
            } else {
                if (ex.status !== 'redeemed' && o.status === 'redeemed') byCode.set(k, o);
            }
        }
        return Array.from(byCode.values());
    }, [orders]);

    // 未引換のみ（新しい順）
    const pendingForOrderTab = useMemo(
        () => canonicalOrdersForOrderTab.filter(o => o.status === 'paid').sort((a, b) => b.createdAt - a.createdAt),
        [canonicalOrdersForOrderTab]
    );

    const [openTicketIdOrder, setOpenTicketIdOrder] = useState<string | null>(null);

    const toOrder = (sid: string) => { setOrderTarget(sid); setTab("order"); };

    const confirmPay = useCallback(async () => {
        if (!orderTarget || isPayingRef.current || isPaying) return;
        isPayingRef.current = true;
        setIsPaying(true);

        try {
            const sid = orderTarget;

            // カード検証
            let payBrand = "TEST";
            if (paymentMethod === "card") {
                const card = validateTestCard(cardDigits);
                if (!card.ok) { emitToast("error", card.msg); return; }
                payBrand = card.brand || "TEST";
            } else {
                // TODO(req v2): PayPay 本実装。現状はテストとして即時成功扱い。
                payBrand = "PayPay";
            }

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
            // store_id は ENV（NEXT_PUBLIC_STORE_ID）の UUID を使用する
            if (!storeId) {
                emitToast("error", "STORE_ID が未設定です（.env.local の NEXT_PUBLIC_STORE_ID を確認）");
                return;
            }

            const orderPayload = {
                store_id: sid as any, // 購入店舗の id（stores.id）を保存
                code: to6(oid),
                customer: userEmail || "guest@example.com",
                items: linesSnapshot.map(l => ({
                    id: l.item.id,
                    name: l.item.name,
                    qty: l.qty,
                    price: l.item.price,  // ★ 重要：価格もスナップショット保存
                })), // JSONB
                total: amount,          // number（文字列ではない）
                status: "PENDING" as const,
                // placed_at は DB 側に DEFAULT now() がある想定。なければ後で DB に追加。
            };



            // Supabaseが設定されていればDBへ作成
            if (supabase) {
                let data: any = null;
                let error: any = null;
                let status = 200;

                try {
                    const rows = await restInsertOrder(orderPayload);
                    data = Array.isArray(rows) ? rows[0] : rows;
                } catch (e: any) {
                    status = Number((e.message || '').match(/HTTP (\d{3})/)?.[1] || 500);
                    error = { message: e.message };
                }

                if (error) {
                    // ---- ここから詳細ログ強化（開発時のみ想定。不要になったら削除OK）----
                    console.error("[orders.insert] status", status);
                    console.error("[orders.insert] payload", JSON.stringify(orderPayload, null, 2));
                    console.error("[orders.insert] env.heads", {
                        url: (process.env.NEXT_PUBLIC_SUPABASE_URL || "").slice(0, 32),
                        anon: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").slice(0, 12),
                        storeId,
                    });
                    console.error("[orders.insert] error raw", error);
                    try {
                        console.error("[orders.insert] error json", JSON.stringify(error, null, 2));
                    } catch { }
                    // ---- ここまで ----

                    emitToast("error", `注文の作成に失敗: ${error.message || "不明なエラー"}`);
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

                // 在庫を「支払い時点」でDBに反映（テスト運用）
                // TODO(req v2): 原子的減算のためサーバーRPC等へ移行
                try {
                    await Promise.all(linesSnapshot.map(async (l) => {
                        const { data: prod } = await supabase.from('products').select('id, stock').eq('id', l.item.id).single();
                        const cur = Math.max(0, Number((prod as any)?.stock ?? 0));
                        const next = Math.max(0, cur - l.qty);
                        await supabase.from('products').update({ stock: next }).eq('id', l.item.id);
                    }));
                } catch {/* noop */ }

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

            const card = { brand: payBrand } as const; // テスト用: 旧トースト文言互換
            setCardDigits("");
            emitToast("success", `注文が完了しました。カード: ${card.brand || "TEST"}`);
        } finally {
            isPayingRef.current = false;
            setIsPaying(false);
        }
    }, [orderTarget, isPaying, cardDigits, cartByShop, itemsById, shops, cart, userEmail, supabase, paymentMethod]);

    // --- 開発用：この店舗の注文をすべてリセット（削除） ---
    const devResetOrders = useCallback(async () => {
        // .env.local に NEXT_PUBLIC_STORE_ID が必要
        if (!storeId) {
            emitToast("error", "STORE_ID が未設定です（.env.local の NEXT_PUBLIC_STORE_ID を確認）");
            return;
        }
        if (!confirm("この店舗の全注文を削除します。よろしいですか？")) return;

        try {
            const { error } = await supabase
                .from("orders")
                .delete()
                .eq("store_id", storeId);   // 店舗単位で削除

            if (error) {
                console.error("[orders.reset] error", error);
                emitToast("error", `リセット失敗: ${error.message}`);
                return;
            }

            // 画面側も空に
            setOrders([]);
            emitToast("success", "注文をリセットしました");
        } catch (e: any) {
            console.error("[orders.reset] exception", e);
            emitToast("error", `例外: ${e?.message ?? e}`);
        }
    }, [supabase, storeId, setOrders]);

    // UI 共通
    const Tab = ({ id, label, icon }: { id: "home" | "cart" | "order" | "account"; label: string; icon: string }) => {
        const isActive = (tab === id) && !(id === 'order' && !!orderTarget);
        const cls = `flex-1 py-2 text-center cursor-pointer ${isActive ? "text-zinc-900 font-semibold" : "text-zinc-500"}`;
        return (
            <button onClick={() => { if (id === 'order') setOrderTarget(undefined); setTab(id); }} className={cls}>
                <div>{icon}</div><div className="text-xs">{label}</div>
            </button>
        );
    };



    const QtyChip = ({ sid, it }: { sid: string; it: Item }) => {
        const reserved = getReserved(sid, it.id);
        const remain = Math.max(0, it.stock - reserved);
        return (
            <div className="inline-flex items-center rounded-full px-2 py-1 text-sm select-none">
                <button
                    type="button"
                    className="w-7 h-7 text-[10px] leading-none rounded-full border cursor-pointer disabled:opacity-40 flex items-center justify-center"
                    disabled={reserved <= 0}
                    onClick={() => changeQty(sid, it, -1)}
                    aria-label="数量を減らす"
                >−</button>
                <span className="mx-3 min-w-[1.5rem] text-center tabular-nums">{reserved}</span>
                <button
                    type="button"
                    className="w-7 h-7 text-[10px] leading-none rounded-full border cursor-pointer disabled:opacity-40 flex items-center justify-center"
                    disabled={remain <= 0}
                    onClick={() => changeQty(sid, it, +1)}
                    aria-label="数量を増やす"
                >＋</button>
            </div>
        );
    };

    // 共通：商品1行（ホーム/カートで再利用）
    // noChrome=true のとき、外枠（rounded/border/bg）を外す
    const ProductLine = ({
        sid,
        it,
        noChrome = false,
    }: {
        sid: string;
        it: Item;
        noChrome?: boolean;
    }) => {
        const reserved = getReserved(sid, it.id);
        const remain = Math.max(0, it.stock - reserved);

        const wrapBase = "relative flex gap-3 p-2 pr-3";
        const chrome = "rounded-2xl border bg-white";
        const wrapperCls = `${wrapBase} ${noChrome ? "" : chrome}`;

        return (
            <div className={wrapperCls}>
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    {/* サムネ（main → sub1 → sub2 → 絵文字） */}
                    <button
                        type="button"
                        role="button"
                        tabIndex={0}
                        aria-label={`${it.name} の画像を開く`}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                (e.currentTarget as HTMLButtonElement).click();
                            }
                        }}
                        onClick={() => {
                            setDetail({ shopId: sid, item: it });
                            setGIndex(0);
                        }}
                        className="relative w-24 h-24 overflow-hidden rounded-xl bg-zinc-100 flex items-center justify-center shrink-0 border cursor-pointer group focus:outline-none focus:ring-2 focus:ring-zinc-900/50"
                        title="画像を開く"
                    >
                        {it.main_image_path ? (
                            <div
                                aria-hidden="true"
                                className="absolute inset-0 pointer-events-none transition-transform group-hover:scale-[1.02]"
                                style={{
                                    backgroundImage: `url(${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${it.main_image_path})`,
                                    backgroundSize: 'cover',
                                    backgroundPosition: 'center',
                                    // ▼ 再描画時に“真っ白”を見せないためのプレースホルダ色（容器と同系）
                                    backgroundColor: '#f4f4f5',
                                    // ▼ GPU面に載せてフラッシュを防止
                                    transform: 'translateZ(0)',
                                    backfaceVisibility: 'hidden',
                                    willChange: 'transform'
                                }}
                            />
                        ) : (
                            <span className="text-4xl pointer-events-none">{it.photo ?? "🛍️"}</span>
                        )}


                        {/* のこり個数チップ（クリック非干渉） */}
                        <span aria-hidden="true" className="pointer-events-none absolute left-1.5 bottom-1.5">
                            <RemainChip remain={remain} className="shadow-sm" />
                        </span>

                        <span className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-black/5" />
                    </button>

                    {/* テキスト側 → 詳細モーダルを開く */}
                    <button
                        type="button"
                        onClick={() => setDetail({ shopId: sid, item: it })}
                        className="flex-1 min-w-0 text-left"
                    >
                        <div className="w-full text-md font-bold leading-tight break-words line-clamp-2 min-h-[2.5rem]">
                            {it.name}
                        </div>
                        <div className="mt-0.5 text-xs text-zinc-500 flex items-center gap-1 w-full">
                            <span>⏰</span>
                            <span className="truncate">受取 {it.pickup}</span>
                        </div>
                        <div className="mt-2 text-base font-semibold">{currency(it.price)}</div>
                    </button>
                </div>

                {/* 右下：数量チップ */}
                <div
                    className="absolute bottom-0 right-1 rounded-full px-2 py-1"
                    onClick={(e) => e.stopPropagation()}
                >
                    <QtyChip sid={sid} it={it} />
                </div>
            </div>
        );
    };


    // 店舗カード詳細メタ開閉
    const [metaOpen, setMetaOpen] = useState<Record<string, boolean>>({});


    // SSR時は描画を保留してクライアントで初回描画
    if (!hydrated) return null;

    return (
        <MinimalErrorBoundary>
            <div className="min-h-screen bg-[#f6f1e9]">{/* 柔らかいベージュ背景 */}
                <header className="sticky top-0 z-20 bg-white/85 backdrop-blur border-b">
                    <div className="max-w-[448px] mx-auto px-4 py-3 flex items-center justify-between" suppressHydrationWarning>
                        <h1 className="text-lg font-bold">ユーザーアプリ モック v3</h1>
                        <div className="flex items-center gap-3">
                            <div className="text-xs text-zinc-500">{clock || "—"}</div>
                            {/* カートバッジ */}
                            <button className="relative px-2 py-1 rounded-full border bg-white cursor-pointer" onClick={() => setTab('cart')} aria-label="カートへ">
                                <span>🛒</span>
                                <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center">
                                    {cart.length}
                                </span>
                            </button>
                        </div>
                    </div>
                </header>

                <main className="max-w-[448px] mx-auto px-4 pb-28">
                    {tab === "home" && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">近くのお店</h2>

                            <div className="grid grid-cols-1 gap-3">
                                {shopsSorted.map((s, idx) => {
                                    // 表示用メタ情報を正規化（s.meta が無くても動く）
                                    const m = (() => {
                                        const anyS = s as any;
                                        const open = anyS.open ?? anyS.open_time ?? anyS?.meta?.open;
                                        const close = anyS.close ?? anyS.close_time ?? anyS?.meta?.close;

                                        const hours =
                                            anyS.hours ??
                                            anyS?.meta?.hours ??
                                            (open && close ? `${open}-${close}` : undefined);

                                        const holiday = anyS.holiday ?? anyS.closed ?? anyS?.meta?.holiday;
                                        const payments = Array.isArray(anyS.payments)
                                            ? anyS.payments
                                            : Array.isArray(anyS?.meta?.payments)
                                                ? anyS.meta.payments
                                                : undefined;
                                        const payment = anyS.payment ?? anyS?.meta?.payment;
                                        const category = anyS.category ?? anyS?.meta?.category;

                                        return { hours, holiday, payments, payment, category };
                                    })();

                                    const visibleItems = s.items.filter(it => {
                                        const r = getReserved(s.id, it.id);
                                        const remain = Math.max(0, it.stock - r);
                                        return it.stock > 0 && (remain > 0 || r > 0);
                                    });
                                    const hasAny = visibleItems.length > 0;
                                    const remainingTotal = visibleItems.reduce(
                                        (a, it) => a + Math.max(0, it.stock - getReserved(s.id, it.id)),
                                        0
                                    );
                                    const minPrice = hasAny ? Math.min(...visibleItems.map(it => it.price)) : 0;
                                    const cartCount = qtyByShop[s.id] || 0;

                                    const isOpen = !!metaOpen[s.id];

                                    return (
                                        <CardObserver
                                            key={s.id}
                                            observe={isOpen}
                                            onLeave={() => {
                                                // カード全体が完全に画面外へ出た瞬間に閉じる
                                                setMetaOpen(prev => ({ ...prev, [s.id]: false }));
                                            }}
                                        >
                                            <div
                                                className={`relative rounded-2xl border bg-white p-4 ${!hasAny ? "opacity-70" : ""
                                                    } ${focusedShop === s.id ? "ring-2 ring-zinc-900" : ""}`}
                                            >
                                                {/* ヒーロー画像 */}
                                                <div className="relative">
                                                    <img
                                                        src={
                                                            s.cover_image_path
                                                                ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${s.cover_image_path}`
                                                                : idx % 3 === 0
                                                                    ? "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?q=80&w=1200&auto=format&fit=crop"
                                                                    : idx % 3 === 1
                                                                        ? "https://images.unsplash.com/photo-1475855581690-80accde3ae2b?q=80&w=1200&auto=format&fit=crop"
                                                                        : "https://images.unsplash.com/photo-1460306855393-0410f61241c7?q=80&w=1200&auto=format&fit=crop"
                                                        }
                                                        alt={s.name}
                                                        className="w-full h-44 object-cover rounded-2xl"
                                                    />
                                                    <div className="absolute left-3 top-3 px-2 py-1 rounded bg-black/60 text-white text-sm">
                                                        {s.name}
                                                    </div>
                                                    <div className="absolute right-3 top-3 px-2 py-1 rounded-full bg-white/90 border text-[11px]">
                                                        {s.distance.toFixed(2)} km
                                                    </div>
                                                </div>

                                                {hasAny ? (
                                                    <div className="mt-3 space-y-2">
                                                        {visibleItems.map(it => (
                                                            <ProductLine key={it.id} sid={s.id} it={it} />
                                                        ))}

                                                    </div>
                                                ) : (
                                                    <div className="mt-3">
                                                        <div className="rounded-xl border border-dashed p-4 text-center text-sm text-zinc-500 bg-zinc-50">
                                                            {s.items.length === 0
                                                                ? "登録商品がありません。"
                                                                : "現在、販売可能な商品はありません。"}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* カートボタン（スクショ風） */}
                                                <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 items-center">
                                                    <button
                                                        type="button"
                                                        className="w-full px-3 py-2 rounded-xl border cursor-pointer disabled:opacity-40 bg-white"
                                                        disabled={(qtyByShop[s.id] || 0) === 0}
                                                        onClick={() => setTab("cart")}
                                                    >
                                                        カートを見る（{qtyByShop[s.id] || 0}）
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="px-3 py-2 rounded-xl border cursor-pointer disabled:opacity-40 text-zinc-700"
                                                        disabled={(qtyByShop[s.id] || 0) === 0}
                                                        onClick={() => clearShopCart(s.id)}
                                                        title="カートを空にする"
                                                    >
                                                        🗑️
                                                    </button>
                                                </div>

                                                {/* ▼ 開閉CTA：デフォルト閉 ＆ トグル */}
                                                <div className="mt-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setMetaOpen(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                                                        className="w-full inline-flex items-center justify-center gap-2 text-sm text-zinc-700 px-3 py-2 rounded-xl border bg-white hover:bg-zinc-50"
                                                        aria-expanded={isOpen}
                                                        aria-controls={`shop-meta-${s.id}`}
                                                    >
                                                        <span>{isOpen ? "店舗詳細を閉じる" : "店舗詳細を表示"}</span>
                                                        <span className={`transition-transform ${isOpen ? "rotate-180" : ""}`}>⌄</span>
                                                    </button>
                                                </div>

                                                {/* 店舗メタ情報（折りたたみ本体） */}
                                                {isOpen && (
                                                    <div
                                                        id={`shop-meta-${s.id}`}
                                                        className="mt-3 pt-3"
                                                    >
                                                        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-700">
                                                            {/* 営業時間 */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>🕒</span>
                                                                <span>営業時間</span>
                                                                <span className="font-medium">{m.hours ?? "—"}</span>
                                                            </span>

                                                            {/* 定休日 */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>📅</span>
                                                                <span>定休日</span>
                                                                <span className="font-medium">{m.holiday ?? "—"}</span>
                                                            </span>

                                                            {/* 決済方法（必要なら復帰） */}
                                                            {/* <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                <span>💳</span>
                <span>決済</span>
                <span className="font-medium">
                  {m.payments?.join(" / ") ?? (m.payment ?? "—")}
                </span>
              </span> */}

                                                            {/* カテゴリ */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>🏷️</span>
                                                                <span className="font-medium">{m.category ?? "—"}</span>
                                                            </span>

                                                            {/* 距離 */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>🚶</span>
                                                                <span className="font-medium">{s.distance.toFixed(2)} km</span>
                                                            </span>

                                                            {/* 最安・在庫（必要なら復帰） */}
                                                            {/* <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                <span>💰</span>
                <span>最安</span>
                <span className="font-semibold">{hasAny ? currency(minPrice) : "—"}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                <span>📦</span>
                <span>在庫</span>
                <span className="tabular-nums font-semibold">{remainingTotal}</span>
              </span> */}
                                                        </div>

                                                        {/* 住所/ミニマップ（スクショ風） */}
                                                        <div className="mt-3">
                                                            <div className="flex items-center gap-2 text-sm text-zinc-700">
                                                                <span>📍</span>
                                                                <span className="truncate flex-1">{s.address ?? "住所未登録"}</span>
                                                                <a
                                                                    href={googleMapsUrlForShop(s)}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="ml-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[13px] font-semibold text-[#6b0f0f] border-[#6b0f0f] hover:bg-[#6b0f0f]/5"
                                                                    aria-label="Googleマップで開く"
                                                                >
                                                                    <IconMapPin className="w-4 h-4" />
                                                                    <span>MAP</span>
                                                                    <IconExternal className="w-4 h-4 text-zinc-400" />
                                                                </a>

                                                            </div>

                                                            <div className="relative mt-2">
                                                                <div className="relative mt-2">
                                                                    <MapView lat={s.lat} lng={s.lng} name={s.name} />
                                                                </div>

                                                                {/* <div className="absolute right-2 top-2 px-2 py-1 rounded bg-white/90 border text-[11px]">
                                                                35.171, 136.881
                                                            </div>
                                                            <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600 pointer-events-none">
                                                                <span>📍 ここにあります</span>
                                                            </div> */}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                                {!hasAny && (
                                                    <div
                                                        className="pointer-events-none absolute inset-0 rounded-2xl bg-black/5"
                                                        aria-hidden="true"
                                                    />
                                                )}
                                            </div>

                                        </CardObserver>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {tab === "cart" && (
                        <section className="mt-4 space-y-4">
                            <div className="flex items-center justify-between">
                                <h2 className="text-base font-semibold">カート（店舗別会計）</h2>
                                <button
                                    type="button"
                                    className="text-xs px-2 py-1 rounded border cursor-pointer disabled:opacity-40"
                                    onClick={clearAllCarts}
                                    disabled={cart.length === 0}
                                    aria-disabled={cart.length === 0}
                                >カートを全て空にする</button>
                            </div>
                            {Object.keys(cartByShop).length === 0 && <p className="text-sm text-zinc-500">カートは空です</p>}
                            {Object.keys(cartByShop).map(sid => (
                                <div key={sid} className="rounded-2xl border bg-white">
                                    <div className="p-4 border-b flex items-center justify-between">
                                        <div className="text-sm font-semibold">{shopsById.get(sid)?.name || sid}</div>
                                    </div>
                                    <div className="p-4 divide-y divide-zinc-200">
                                        {(cartByShop[sid] || []).map((l) => (
                                            <ProductLine key={`${l.item.id}-${sid}`} sid={sid} it={l.item} noChrome />
                                        ))}
                                    </div>

                                    {/* 受け取り予定時間（必須） */}
                                    <div className="px-4">
                                        <div className="border-t mt-2 pt-3">
                                            <PickupTimeSelector
                                                storeId={sid}
                                                value={pickupByShop[sid] ?? null}
                                                onSelect={(slot) => setPickupByShop(prev => ({ ...prev, [sid]: slot }))}
                                            // leadCutoffMin={20}       // ← 省略すると20
                                            // nearThresholdMin={30}    // ← 省略すると30（任意）
                                            />
                                            {!pickupByShop[sid] && (
                                                <p className="mt-2 text-xs text-red-500">受け取り予定時間を選択してください。</p>
                                            )}
                                        </div>
                                    </div>


                                    <div className="px-4 pt-3">
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="font-medium">合計金額</span>
                                            <span className="tabular-nums font-bold text-lg">{currency(shopTotal(sid))}</span>
                                        </div>
                                    </div>
                                    <div className="p-4 border-t mt-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const sel = pickupByShop[sid];
                                                if (!sel) return;
                                                const startMin = Number(sel.start.slice(0, 2)) * 60 + Number(sel.start.slice(3, 5));
                                                const nowMin = nowMinutesJST();
                                                if (startMin < nowMin + LEAD_CUTOFF_MIN) {
                                                    alert(`受け取り開始まで${Math.max(0, startMin - nowMin)}分です。直近枠は選べません（${LEAD_CUTOFF_MIN}分前まで）。`);
                                                    return;
                                                }
                                                toOrder(sid);
                                            }}

                                            disabled={!pickupByShop[sid]}
                                            className={`w-full px-3 py-2 rounded text-white cursor-pointer
    ${!pickupByShop[sid] ? "bg-zinc-300 cursor-not-allowed" : "bg-zinc-900 hover:bg-zinc-800"}`}
                                            aria-disabled={!pickupByShop[sid]}
                                        >
                                            注文画面へ
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {tab === "order" && !orderTarget && (
                        <section className="mt-4 space-y-3">
                            <h2 className="text-base font-semibold">未引換のチケット</h2>
                            {pendingForOrderTab.length === 0 && (
                                <div className="text-sm text-zinc-500">未引換のチケットはありません。</div>
                            )}
                            {pendingForOrderTab.length > 0 && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm text-zinc-600">引換待ちのチケット</div>
                                        <div className="text-[11px] text-zinc-500">{pendingForOrderTab.length}件</div>
                                    </div>
                                    {pendingForOrderTab.map(o => {
                                        const shopName = shopsById.get(o.shopId)?.name || o.shopId;
                                        const isOpen = openTicketIdOrder === o.id;
                                        return (
                                            <div key={o.id} className={`rounded-2xl border bg-white ${isOpen ? 'p-4' : 'p-3'}`}>
                                                <button type="button" aria-expanded={isOpen} aria-controls={`ticket-${o.id}`} className="w-full flex items-center justify-between cursor-pointer" onClick={() => setOpenTicketIdOrder(isOpen ? null : o.id)}>
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <span className="text-lg leading-none">{isOpen ? '▾' : '▸'}</span>
                                                        <div className="text-left truncate">
                                                            <div className="text-sm font-semibold truncate">{shopName}</div>
                                                            <div className="text-[11px] text-zinc-500 truncate">注文番号 {o.id}</div>
                                                        </div>
                                                    </div>
                                                    <div className="text-xs px-2 py-1 rounded bg-amber-100 shrink-0">{statusText(o.status)}</div>
                                                </button>
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
                                                        <div className="mt-4">
                                                            <div className="text-xs text-zinc-500 mb-1">購入内容</div>
                                                            <ul className="space-y-1">
                                                                {o.lines.map((l, i) => (
                                                                    <li key={`${l.item.id}-${i}`} className="flex items-center justify-between text-sm">
                                                                        <span className="truncate mr-2">{l.item.name}</span>
                                                                        <span className="tabular-nums">×{l.qty}</span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                        {/* TODO(req v2): 本番ではこの削除機能を無効化/非表示にする（テスト運用限定） */}
                                                        <div className="mt-3 flex items-center gap-2">
                                                            <button
                                                                type="button"
                                                                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 cursor-pointer"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (!confirm('このチケットを削除しますか？（ローカルのみ削除）')) return;
                                                                    setOrders(prev => prev.filter(x => !(String(x.id) === String(o.id) && x.status === 'paid')));
                                                                    emitToast('success', 'チケットを削除しました');
                                                                }}
                                                            >
                                                                このチケットを削除
                                                            </button>
                                                        </div>
                                                        <div className="text-xs text-zinc-500 mt-3">※ 店頭で6桁コードまたはQRを提示してください。受取完了は店側アプリで行われ、ステータスが <b>redeemed</b> に更新されます。</div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}
                    {/*
                    {tab === "order" && orderTarget && (
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
                    */}
                    {tab === "order" && orderTarget && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">注文の最終確認</h2>
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
                                                <div className="text-xs text-zinc-500">受取 {l.item.pickup} / 注意 {l.item.note || "-"}</div>
                                            </div>
                                            <div className="tabular-nums">{currency(l.item.price * l.qty)}</div>
                                        </div>
                                    ))}
                                </div>
                                <div className="p-4 border-t space-y-2">
                                    {/* 支払い方法 */}
                                    <div className="grid grid-cols-2 gap-2" role="group" aria-label="支払い方法">
                                        {(() => {
                                            const base = "w-full px-3 py-2 rounded border cursor-pointer text-sm";
                                            const active = "bg-zinc-900 text-white border-zinc-900";
                                            const inactive = "bg-white text-zinc-700";
                                            return (
                                                <>
                                                    <button
                                                        type="button"
                                                        className={`${base} ${paymentMethod === 'card' ? active : inactive}`}
                                                        aria-pressed={paymentMethod === 'card'}
                                                        onClick={() => setPaymentMethod('card')}
                                                    >
                                                        クレカ
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`${base} ${paymentMethod === 'paypay' ? active : inactive}`}
                                                        aria-pressed={paymentMethod === 'paypay'}
                                                        onClick={() => setPaymentMethod('paypay')}
                                                    >
                                                        PayPay
                                                    </button>
                                                </>
                                            );
                                        })()}
                                    </div>
                                    <div className="text-xs text-zinc-500">テストカード例: 4242… は成功。400000… は失敗（例: 4000 0000 0000 0002）。入力は数字のみ。</div>
                                    {(() => {
                                        const d = cardDigits.replace(/\D/g, "").slice(0, 16);
                                        const formatted = (d.match(/.{1,4}/g)?.join(" ") ?? d);
                                        const len = d.length;
                                        return (
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
                                                    <span>4桁ごとにスペース</span>
                                                </div>
                                                <div className="h-1 bg-zinc-200 rounded">
                                                    <div className="h-1 bg-zinc-900 rounded" style={{ width: `${(len / 16) * 100}%` }} />
                                                </div>
                                            </>
                                        );
                                    })()}
                                    <button
                                        type="button"
                                        className="w-full px-3 py-2 rounded border cursor-pointer disabled:opacity-40"
                                        onClick={confirmPay}
                                        disabled={
                                            isPaying ||
                                            ((cartByShop[orderTarget]?.length ?? 0) === 0) ||
                                            (paymentMethod === 'card' && cardDigits.length < 16)
                                        }
                                    >
                                        支払いを確定する（テスト）
                                    </button>
                                </div>
                            </div>
                        </section>
                    )}
                    {tab === "account" && (
                        <AccountView orders={orders} shopsById={shopsById} onDevReset={devResetOrdersStrict} onDevResetHistory={devResetOrderHistory} />
                    )}

                </main>

                <footer className="fixed bottom-0 left-0 right-0 border-t bg-white/90">
                    <div className="max-w-[448px] mx-auto grid grid-cols-4 text-center">
                        <Tab id="home" label="ホーム" icon="🏠" />
                        <Tab id="cart" label="カート" icon="🛒" />
                        <Tab id="order" label="引換え" icon="🧾" />
                        <Tab id="account" label="アカウント" icon="👤" />
                    </div>
                </footer>

                {/* 規約リンク */}
                <div className="max-w-[448px] mx-auto px-4 py-2 text-center text-[10px] text-zinc-500">
                    <a className="underline cursor-pointer" href="#">利用規約</a> ・ <a className="underline cursor-pointer" href="#">プライバシー</a>
                </div>

                <ToastBar toast={toast} onClose={() => setToast(null)} />



                {/* 商品詳細モーダル */}
                {detail && (
                    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[2000]">
                        <div
                            className="absolute inset-0 bg-black/40 z-[2000]"
                            onClick={() => setDetail(null)}
                        />
                        <div className="absolute inset-0 flex items-center justify-center p-4 z-[2001]">
                            <div className="max-w-[520px] w-full bg-white rounded-2xl overflow-hidden shadow-xl">
                                <div className="relative">
                                    {/* メイン画像（3枚ギャラリー） */}
                                    {detailImages.length > 0 ? (
                                        <img
                                            key={detailImages[gIndex]}
                                            src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${detailImages[gIndex]}`}
                                            alt={`${detail.item.name} 画像 ${gIndex + 1}/${detailImages.length}`}
                                            className="w-full aspect-[4/3] object-cover bg-black"
                                            loading="eager"
                                            decoding="async"
                                        />

                                    ) : (
                                        <div className="w-full h-56 bg-zinc-100 flex items-center justify-center text-6xl">
                                            <span>{detail.item.photo}</span>
                                        </div>
                                    )}

                                    {/* 左右ナビ（画像が2枚以上あるときだけ） */}
                                    {detailImages.length > 1 && (
                                        <>
                                            <button
                                                type="button"
                                                className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-2 rounded-full bg-white/90 border shadow hover:bg-white"
                                                onClick={() => setGIndex(i => Math.max(0, i - 1))}
                                                disabled={gIndex === 0}
                                                aria-label="前の画像"
                                            >‹</button>
                                            <button
                                                type="button"
                                                className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-2 rounded-full bg-white/90 border shadow hover:bg-white"
                                                onClick={() => setGIndex(i => Math.min(detailImages.length - 1, i + 1))}
                                                disabled={gIndex === detailImages.length - 1}
                                                aria-label="次の画像"
                                            >›</button>
                                        </>
                                    )}

                                    {/* 閉じる */}
                                    <button
                                        type="button"
                                        aria-label="閉じる"
                                        className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 border flex items-center justify-center"
                                        onClick={() => setDetail(null)}
                                    >✕</button>
                                </div>

                                <div className="p-4 space-y-3">
                                    {/* サムネトレイ（クリックで切替） */}
                                    {detailImages.length > 1 && (
                                        <div className="border-b pb-3 -mt-1">
                                            <div className="flex items-center gap-2 overflow-x-auto">
                                                {detailImages.map((pth, idx) => (
                                                    <button
                                                        key={pth}
                                                        className={`relative w-16 h-16 rounded border overflow-hidden ${idx === gIndex ? "ring-2 ring-zinc-900" : ""}`}
                                                        onClick={() => setGIndex(idx)}
                                                        aria-label={`サムネイル ${idx + 1}`}
                                                    >
                                                        <img
                                                            src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${pth}`}
                                                            alt={`${detail.item.name} thumb ${idx + 1}`}
                                                            className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
                                                            loading="lazy"
                                                            decoding="async"
                                                        />

                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div className="text-lg font-semibold leading-tight break-words">{detail.item.name}</div>
                                    <div className="text-sm text-zinc-600 flex items-center gap-3">
                                        <span className="inline-flex items-center gap-1"><span>⏰</span><span>受取 {detail.item.pickup}</span></span>
                                        <span className="inline-flex items-center gap-1"><span>🏷️</span><span className="tabular-nums">{currency(detail.item.price)}</span></span>
                                        <span className="ml-auto">
                                            <RemainChip remain={Math.max(0, detail.item.stock - getReserved(detail.shopId, detail.item.id))} />
                                        </span>
                                    </div>
                                    <div className="text-sm text-zinc-700 bg-zinc-50 rounded-xl p-3">
                                        {detail.item.note ? detail.item.note : 'お店のおすすめ商品です。数量限定のため、お早めにお求めください。'}
                                    </div>
                                    <div className="flex items-center justify-between pt-2">
                                        <div className="text-base font-semibold">{currency(detail.item.price)}</div>
                                        <div className="rounded-full  px-2 py-1">
                                            <QtyChip sid={detail.shopId} it={detail.item} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 pt-1">
                                        <button type="button" className="px-3 py-2 rounded-xl border" onClick={() => setDetail(null)}>閉じる</button>
                                        <button type="button" className="px-3 py-2 rounded-xl border bg-zinc-900 text-white" onClick={() => { addToCart(detail.shopId, detail.item); emitToast('success', 'カートに追加しました'); setDetail(null); }}>カートに追加</button>
                                    </div>
                                </div>

                            </div>
                        </div>
                    </div>
                )}
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

function AccountView({
    orders,
    shopsById,
    onDevReset,
    onDevResetHistory,
}: {
    orders: Order[];
    shopsById: Map<string, Shop>;
    onDevReset?: () => void;
    onDevResetHistory?: () => void;
}) {

    const [refreshTick, setRefreshTick] = useState(0);

    // ▼▼ 重複除去：同じ code6 が複数ある場合は redeemed を優先して 1 件に正規化 ▼▼
    const canonicalOrders = useMemo(() => {

        const byCode = new Map<string, Order>();
        for (const o of orders) {
            const k = String(o.code6 ?? "");   // ★ 完全一致キー
            const ex = byCode.get(k);
            if (!ex) {
                byCode.set(k, o);
            } else {
                // 片方が redeemed なら redeemed を優先して残す
                if (ex.status !== "redeemed" && o.status === "redeemed") {
                    byCode.set(k, o);
                }
                // それ以外（同格）は先勝ち
            }
        }
        return Array.from(byCode.values());
    }, [orders]);

    // 未引換（paid）は canonical に対して切り出す
    const pending = useMemo(
        () => canonicalOrders.filter(o => o.status === "paid").sort((a, b) => b.createdAt - a.createdAt),
        [canonicalOrders, refreshTick]
    );

    const [openTicketId, setOpenTicketId] = useState<string | null>(null);
    const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);

    const statusText = (s: Order["status"]) => (
        s === 'redeemed' ? '引換済み' : s === 'paid' ? '未引換' : s === 'refunded' ? '返金済み' : s
    );

    // 履歴も canonical を元に
    const sortedOrders = useMemo(
        () => [...canonicalOrders].sort((a, b) => b.createdAt - a.createdAt),
        [canonicalOrders]
    );

    const [showAllHistory, setShowAllHistory] = useState(false);
    const MAX_COMPACT = 5;
    const visibleOrders = showAllHistory ? sortedOrders : sortedOrders.slice(0, MAX_COMPACT);
    const remaining = Math.max(0, sortedOrders.length - visibleOrders.length);

    return (
        <section className="mt-4 space-y-4">
            <h2 className="text-base font-semibold">アカウント / チケット</h2>

            {/* 未引換チケット（アコーディオン・QR単一表示） */}
            {false && pending.length === 0 && (
                <div className="text-sm text-zinc-500">未引換のチケットはありません。</div>
            )}
            {false && pending.length > 0 && (
                <div className="space-y-3">
                    {/* 未引換のチケット */}
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">未引換のチケット</div>
                        <div className="flex items-center gap-2">
                            {process.env.NODE_ENV !== 'production' && onDevReset && (
                                <button
                                    type="button"
                                    onClick={onDevReset}
                                    className="text-[11px] px-2 py-1 rounded border bg-red-50 hover:bg-red-100 cursor-pointer"
                                    title="この店舗の注文をすべて削除（開発専用）"
                                >
                                    リセット
                                </button>
                            )}
                            <div className="text-[11px] text-zinc-500">{pending.length}件</div>
                        </div>
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
                                    <div className="text-xs px-2 py-1 rounded bg-amber-100 shrink-0">状態: {o.status}</div>
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
                                        <div className="mt-4">
                                            <div className="text-xs text-zinc-500 mb-1">購入内容</div>
                                            <ul className="space-y-1">
                                                {o.lines.map((l, i) => (
                                                    <li key={`${l.item.id}-${i}`} className="flex items-center justify-between text-sm">
                                                        <span className="truncate mr-2">{l.item.name}</span>
                                                        <span className="tabular-nums">×{l.qty}</span>
                                                    </li>
                                                ))}
                                            </ul>
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
                    <div className="flex items-center gap-2">
                        {process.env.NODE_ENV !== 'production' && onDevResetHistory && (
                            <button
                                type="button"
                                onClick={onDevResetHistory}
                                className="text-[11px] px-2 py-1 rounded border bg-red-50 hover:bg-red-100 cursor-pointer"
                                title="履歴のみ削除（開発専用）"
                            >
                                リセット
                            </button>
                        )}
                        <div className="text-[11px] text-zinc-500">{sortedOrders.length}件</div>
                    </div>
                </div>

                <ul className="mt-2 divide-y">
                    {visibleOrders.map(o => {
                        const isOpen = openHistoryId === o.id;
                        const shopName = shopsById.get(o.shopId)?.name || o.shopId;
                        return (
                            <li key={o.id} className="py-2">
                                <button
                                    type="button"
                                    className="w-full flex items-center justify-between text-sm cursor-pointer"
                                    aria-expanded={isOpen}
                                    aria-controls={`history-${o.id}`}
                                    onClick={() => setOpenHistoryId(isOpen ? null : o.id)}
                                >
                                    <div className="min-w-0">
                                        <div className="font-medium truncate">{shopName}</div>
                                        <div className="text-[11px] text-zinc-500 truncate">{new Date(o.createdAt).toLocaleString()} / 注文番号 {o.id}</div>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                        <span className={`text-[11px] px-2 py-0.5 rounded ${o.status === 'redeemed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{statusText(o.status)}</span>
                                        <span className="font-semibold tabular-nums">{currency(o.amount)}</span>
                                        <span className="text-xs">{isOpen ? '▾' : '▸'}</span>
                                    </div>
                                </button>

                                {isOpen && (
                                    <div id={`history-${o.id}`} className="mt-2 px-1 text-sm">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <div className="text-xs text-zinc-500">6桁コード</div>
                                                <div className="text-base font-mono tracking-widest">{o.code6}</div>
                                                <div className="text-xs text-zinc-500 mt-2">ステータス</div>
                                                <div className="text-sm font-medium">{statusText(o.status)}</div>
                                                <div className="text-xs text-zinc-500 mt-2">合計</div>
                                                <div className="text-base font-semibold">{currency(o.amount)}</div>
                                            </div>
                                            <div>
                                                <div className="text-xs text-zinc-500 mb-1">注文内容</div>
                                                <ul className="space-y-1">
                                                    {o.lines.map((l, i) => (
                                                        <li key={`${l.item.id}-${i}`} className="flex items-center justify-between">
                                                            <span className="truncate mr-2">{l.item.name} × {l.qty}</span>
                                                            <span className="tabular-nums">{currency(l.item.price * l.qty)}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
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
