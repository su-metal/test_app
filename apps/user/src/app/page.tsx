"use client";
import React, { useEffect, useMemo, useRef, useState, startTransition, useCallback } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { SupabaseClient } from '@supabase/supabase-js';
// 追加：受取時間の表示コンポーネント
import PickupTimeSelector, { type PickupSlot } from "@/components/PickupTimeSelector";
import { EmbeddedCheckoutProvider, EmbeddedCheckout, useStripe, useElements, PaymentElement } from "@stripe/react-stripe-js";



// Stripe（ブラウザ用 SDK）
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);


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
                    'x-store-id': process.env.NEXT_PUBLIC_STORE_ID || '',
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

// --- 埋め込み可能な Google Maps の src だけを許可 ---
const isAllowedGoogleEmbedSrc = (src: string) => {
    try {
        const u = new URL(src);
        const hostOk = ["www.google.com", "google.com"].includes(u.hostname);
        const pathOk = u.pathname.startsWith("/maps/embed")
            || (u.pathname === "/maps" && u.searchParams.get("output") === "embed");
        return hostOk && pathOk;
    } catch {
        return false;
    }
};

// --- 埋め込みURL（/maps/embed?pb=... または ?q=...&output=embed）から lat,lng を抽出 ---
const extractLatLngFromGoogleEmbedSrc = (src?: string): { lat: number; lng: number } | null => {
    if (!src) return null;
    try {
        const u = new URL(src);
        if (!isAllowedGoogleEmbedSrc(src)) return null;

        // A) /maps/embed?pb=...（代表2パターン）
        const rawPb = u.searchParams.get("pb");
        if (rawPb) {
            const pb = decodeURIComponent(rawPb);

            // ...!3d<lat>!4d<lng>...
            const m34 = pb.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
            if (m34) return { lat: Number(m34[1]), lng: Number(m34[2]) };

            // ...!2d<lng>!3d<lat>...
            const m23 = pb.match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
            if (m23) return { lat: Number(m23[2]), lng: Number(m23[1]) };
        }

        // B) /maps?output=embed&q=lat,lng など
        const q = u.searchParams.get("q");
        if (q) {
            const m = q.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        }

        return null;
    } catch {
        return null;
    }
};

// 埋め込み src を「新タブでピン付きで開ける通常URL」へ変換
function mapsUrlFromEmbedForNewTab(src?: string | null, label?: string | null): string | null {
    const ll = extractLatLngFromGoogleEmbedSrc(src || undefined);
    if (!ll) return null;
    const base = `https://www.google.com/maps/search/?api=1&query=${ll.lat},${ll.lng}`;
    // 任意: 店名をラベルとして付与（見た目の補助）
    if (label && label.trim()) {
        return `${base}&query_place=${encodeURIComponent(label.trim())}`;
    }
    return base;
}


// 開発用にコンソールから叩けるように公開（本番は環境変数で無効）
if (process.env.NEXT_PUBLIC_DEBUG === '1') {
    (globalThis as any).dbgExtractFromEmbed = extractLatLngFromGoogleEmbedSrc;
}


// 埋め込み src（/maps/embed?...）→ フルGoogleマップの「ピンあり」URLへ変換
function viewLargerMapUrlFromEmbed(src?: string | null): string | null {
    if (!src) return null;
    try {
        // まず、埋め込みの座標を確実に抽出
        const ll = extractLatLngFromGoogleEmbedSrc(src || undefined);
        if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
            // ← これが最も確実に“ピンが立つ”
            return `https://www.google.com/maps/search/?api=1&query=${ll.lat},${ll.lng}`;
        }

        // どうしても座標が取れない超例外時のみ、従来の /maps?pb=... にフォールバック
        const u = new URL(src);
        const isGoogle = ["www.google.com", "google.com"].includes(u.hostname);

        if (isGoogle && u.pathname.startsWith("/maps/embed")) {
            u.pathname = "/maps";
            return u.toString(); // ※このパスはピンが出ないことがある（最後の保険）
        }
        if (isGoogle && u.pathname === "/maps" && u.searchParams.get("output") === "embed") {
            u.searchParams.delete("output");
            return u.toString();
        }
        return null;
    } catch {
        return null;
    }
}



// --- 距離計算に使う最良座標（DBの lat/lng は使わない） ---
function bestLatLngForDistance(s: { gmap_embed_src?: string | null; gmap_url?: string | null }): { lat: number; lng: number } | null {
    const fromEmbed = extractLatLngFromGoogleEmbedSrc(s.gmap_embed_src ?? undefined);
    if (fromEmbed && Number.isFinite(fromEmbed.lat) && Number.isFinite(fromEmbed.lng)) return fromEmbed;

    const fromUrl = extractLatLngFromGoogleUrl(s.gmap_url ?? undefined);
    if (fromUrl && Number.isFinite(fromUrl.lat) && Number.isFinite(fromUrl.lng)) return fromUrl;

    return null; // どちらも取れない場合は距離表示しない
}



// --- 共有URL（google.com/maps/… など）から lat,lng を取れる場合は抽出 ---
const extractLatLngFromGoogleUrl = (url?: string): { lat: number; lng: number } | null => {
    if (!url) return null;
    try {
        const u = new URL(url);

        // 1) ".../@35.12345,139.12345,16z"
        const at = u.href.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
        if (at) return { lat: Number(at[1]), lng: Number(at[2]) };

        // 2) "?q=35.12345,139.12345" or "?ll=35.12345,139.12345"
        const q = u.searchParams.get("q");
        const ll = u.searchParams.get("ll");
        const pick = q || ll;
        if (pick) {
            const [lat, lng] = pick.split(/[, ]+/).map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
        }
    } catch { }
    return null;
};

// --- 2点間の距離（km, Haversine）---
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371; // km
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLng / 2);
    const aa = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
    return R * c;
}

// === Supabase Storage の public 画像 URL を作る（クエリ無し・安定） ===
function publicImageUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    return `${base}/storage/v1/object/public/public-images/${path}`;
}


// === 背景画像を IntersectionObserver で遅延ロードし、白フラッシュ無しでフェード表示 ===
function BgImage({
    path,
    alt,
    className,
    eager = false,               // 先頭スライドなど即表示したい時に true
}: {
    path: string | null | undefined;
    alt: string;
    className?: string;
    eager?: boolean;
}) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const [ready, setReady] = React.useState(false);
    const url = publicImageUrl(path);

    React.useEffect(() => {
        if (!url || !ref.current) return;

        const el = ref.current;
        const load = () => {
            // 先に Image オブジェクトで読み込み → onload 後に backgroundImage を差し替え（白フラッシュ回避）
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            img.onload = () => {
                if (!el) return;
                el.style.backgroundImage = `url(${url})`;
                setReady(true);
            };
        };

        if (eager) {
            load();
            return;
        }

        const io = new IntersectionObserver(
            entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        load();
                        io.disconnect();
                    }
                });
            },
            { rootMargin: '200px' } // 少し手前でプリロード
        );

        io.observe(el);
        return () => io.disconnect();
    }, [url, eager]);

    // 低コストのプレースホルダ（薄いグラデ＋色）
    return (
        <div
            ref={ref}
            role="img"
            aria-label={alt}
            className={[
                "bg-zinc-100",
                "bg-[length:cover] bg-center",
                "transition-opacity duration-200",
                ready ? "opacity-100" : "opacity-0",
                className ?? ""
            ].join(" ")}
            style={{
                // プレースホルダとして淡いグラデ（読み込み完了まで表示）
                backgroundImage:
                    "linear-gradient(180deg, rgba(244,244,245,1) 0%, rgba(228,228,231,1) 100%)",
            }}
        />
    );
}


// --- ルート距離（km, OSRM）---
// TODO(req v2): 交通手段（徒歩/自転車/車）の選択を UI 設定化する
async function routeDistanceKm(
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number },
    mode: 'walking' | 'driving' = 'walking'
): Promise<number | null> {
    try {
        const profile = mode === 'walking' ? 'foot' : 'driving';
        const url = `https://router.project-osrm.org/route/v1/${profile}/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=false&alternatives=false&steps=false`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        const meters: unknown = json?.routes?.[0]?.distance;
        if (typeof meters === 'number' && Number.isFinite(meters)) return meters / 1000;
        return null;
    } catch {
        return null;
    }
}

// Embed API（Place ID用）を使う場合だけ .env にキーを置く（無ければ未使用）
const EMBED_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;

// --- 最適ソースから <iframe src> を構築（優先: gmap_embed_src → place_id → URL座標 → lat/lng → 住所）---
const buildMapEmbedSrc = (s: {
    name: string;
    address?: string | null;
    place_id?: string | null;
    gmap_embed_src?: string | null;
    gmap_url?: string | null;
    lat?: number | null;
    lng?: number | null;
    zoomOnPin?: number | null;
}) => {
    const z = Number(s.zoomOnPin ?? 18);

    // A) DBの埋め込みsrc（/maps/embed?pb=…）があれば最優先（キー不要）
    if (s.gmap_embed_src && isAllowedGoogleEmbedSrc(s.gmap_embed_src)) {
        return s.gmap_embed_src;
    }

    // B) Place ID（Embed API + key があるときのみ）
    if (EMBED_KEY && s.place_id) {
        return `https://www.google.com/maps/embed/v1/place?key=${EMBED_KEY}&q=place_id:${encodeURIComponent(s.place_id)}`;
    }

    // C) 共有URLから座標を抽出できたら使う（キー不要）
    const ll = extractLatLngFromGoogleUrl(s.gmap_url ?? undefined);
    if (ll) return `https://www.google.com/maps?q=${ll.lat},${ll.lng}&z=${z}&output=embed`;

    // D) DBのlat/lngがあれば使う（キー不要）
    if (typeof s.lat === "number" && typeof s.lng === "number") {
        return `https://www.google.com/maps?q=${s.lat},${s.lng}&z=${z}&output=embed`;
    }

    // E) 最後は住所検索（多少ズレる可能性）
    if (s.address && s.address.trim()) {
        const q = encodeURIComponent(`${s.name} ${s.address}`);
        return `https://www.google.com/maps?q=${q}&output=embed`;
    }

    // 既存の buildMapEmbedSrc の Place ID 部分だけ、zoom を足す
    if (EMBED_KEY && s.place_id) {
        const z = Number(s.zoomOnPin ?? 18);
        return `https://www.google.com/maps/embed/v1/place?key=${EMBED_KEY}&q=place_id:${encodeURIComponent(s.place_id)}&zoom=${z}`;
    }


    return "https://www.google.com/maps?output=embed";
};

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

// 予約投稿の公開判定（JST基準で「現在時刻 >= publish_at」なら公開）
function isPublishedNow(publish_at?: string | null): boolean {
    if (!publish_at) return true; // 未設定は常に表示
    const now = new Date();       // 実行環境のTZでOK（postedはISO想定）
    const pub = new Date(publish_at);
    return now.getTime() >= pub.getTime();
}


const LEAD_CUTOFF_MIN = 20; // 受け取り開始の何分前まで不可にするか（UI全体の既定）

// === 受取時間ヘルパー： "HH:MM–HH:MM" を [startMin, endMin) に変換 ===
function parsePickupWindow(label: string): { start: number; end: number } | null {
    if (!label) return null;
    // ハイフン/ダッシュのゆらぎ対応（-、–、—、〜 など）
    const norm = label.replace(/[—–〜~]/g, "-");
    const m = norm.match(/(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})/);
    if (!m) return null;
    const h1 = Number(m[1]), m1 = Number(m[2]);
    const h2 = Number(m[3]), m2 = Number(m[4]);
    const start = h1 * 60 + m1;
    const end = h2 * 60 + m2;
    if (!(start >= 0 && end > start)) return null;
    return { start, end };
}

// 受け取り終了（＝現在時刻が受取窓の end を過ぎている）かどうか
function isPickupExpired(label: string): boolean {
    const win = parsePickupWindow(label);
    if (!win) return false; // ラベル不正や未設定は表示対象のまま
    const now = nowMinutesJST();
    return now >= win.end;  // end を過ぎたら「期限切れ」
}


const overlaps = (a: { start: number, end: number }, b: { start: number, end: number }) =>
    a.start < b.end && b.start < a.end; // 端点だけ接する(= end==start)は非重複

// === 同一店舗内のカート行を「受取時間の連結成分」で分割 ===
type CartGroup = {
    key: string;              // 例: `${storeId}|g0`
    storeId: string;
    lines: CartLine[];
    window: { start: number; end: number } | null; // グループの結合区間（表示には使わないがメモ）
};

/** 同一店舗のカート行を、
 *  「グループ内の全商品が共通に重なる時間帯がある」塊ごとに分割する
 *  ※ 連鎖は不許可。10–14 と 15–19 は別グループ。
 */
function groupCartLinesByPickup(lines: CartLine[]): CartGroup[] {
    lines = (lines || []).filter(l => l && l.item && typeof l.item.price === 'number' && typeof l.qty === 'number');
    if (lines.length <= 1) {
        const sid = lines[0]?.shopId ?? "";
        return lines.length
            ? [{
                key: `${sid}|g0`,
                storeId: sid,
                lines: [...lines],
                window: parsePickupWindow(lines[0].item.pickup),
            }]
            : [];
    }

    const sid = lines[0]?.shopId ?? "";

    // 1) ラベル→区間。区間なしは後で単独グループ化
    type Win = { start: number; end: number };
    type Row = { line: CartLine; w: Win | null };
    const rows: Row[] = lines.map(l => ({ line: l, w: parsePickupWindow(l.item.pickup) }));

    const noWin: CartLine[] = [];
    const hasWin: { line: CartLine; w: Win }[] = [];
    for (const r of rows) {
        if (r.w) {
            hasWin.push({ line: r.line, w: r.w });
        } else {
            noWin.push(r.line);
        }
    }


    // 2) 開始→終了の安定ソート
    hasWin.sort((a, b) => (a.w.start - b.w.start) || (a.w.end - b.w.end));

    // 3) 共通交差を保ちながら貪欲に詰める
    const groups: CartGroup[] = [];
    let buf: CartLine[] = [];
    let inter: Win | null = null;
    let gi = 0;

    const flush = () => {
        if (buf.length === 0) return;
        groups.push({
            key: `${sid}|g${gi++}`,
            storeId: sid,
            lines: buf.slice(),
            window: inter ? { ...inter } : null,
        });
        buf = [];
        inter = null;
    };

    for (const { line, w } of hasWin) {
        if (!inter) {
            inter = { ...w };
            buf.push(line);
            continue;
        }
        const ns = Math.max(inter.start, w.start);
        const ne = Math.min(inter.end, w.end);
        if (ns < ne) {
            inter = { start: ns, end: ne }; // 共通交差を狭める
            buf.push(line);
        } else {
            // 共通交差が消えたのでここで区切る
            flush();
            inter = { ...w };
            buf.push(line);
        }
    }
    flush();

    // 4) 受取時間が未設定/不正な行は単独グループ
    for (const l of noWin) {
        groups.push({ key: `${sid}|g${gi++}`, storeId: sid, lines: [l], window: null });
    }

    return groups;
}


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
    return digits.slice(-6);
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
    publish_at?: string | null;
}

interface Shop {
    id: string; name: string; lat: number; lng: number; zoomOnPin: number; closed: boolean; items: Item[],
    address?: string;
    cover_image_path?: string | null;
    tel?: string;
    url?: string;
    hours?: string;    // ★ ：営業時間
    holiday?: string;  // ★ ：定休日
    category?: string; // ★ ：カテゴリー
    gmap_embed_src?: string | null;
    gmap_url?: string | null;
    place_id?: string | null;
}
interface CartLine { shopId: string; item: Item; qty: number }
interface Order { id: string; userEmail: string; shopId: string; amount: number; status: "paid" | "redeemed" | "refunded"; code6: string; createdAt: number; lines: CartLine[] }

type ShopWithDistance = Shop & { distance: number };

// === 受取プリセット取得（全店舗分） ===
// store_id ごとに { current, slots:{[slot_no]:{start,end,name,step}} } を保持
type PresetSlot = { start: string; end: string; name: string; step: number };
type StorePresetInfo = { current: number | null, slots: Record<number, PresetSlot> };


function useStorePickupPresets(
    supabase: SupabaseClient | null,
    dbStores: any[],
    dbProducts: any[]
): {
    presetMap: Record<string, StorePresetInfo>;
    pickupLabelFor: (storeId: string, productSlotNo?: number | null) => string | null;
} {

    const [map, setMap] = useState<Record<string, StorePresetInfo>>({});

    // 取得対象の store_id を、stores / products の両方からユニークに集める
    const storeIds = useMemo(() => {
        const ids = new Set<string>();
        dbStores.forEach(s => ids.add(String(s.id)));
        dbProducts.forEach(p => { if (p.store_id) ids.add(String(p.store_id)); });
        return Array.from(ids);
    }, [dbStores, dbProducts]);

    useEffect(() => {
        if (!supabase) return;
        (async () => {
            // 1) 現在プリセット番号（stores）
            const currentById = new Map<string, number | null>();
            for (const s of dbStores) currentById.set(String(s.id), (s as any).current_pickup_slot_no ?? null);

            // 2) プリセット本体（store_pickup_presets）
            let sel = supabase
                .from('store_pickup_presets')
                .select('store_id,slot_no,name,start_time,end_time,slot_minutes');

            // storeIds があれば IN フィルタ、なければ全件（上限）を読む
            if (storeIds.length > 0) {
                sel = sel.in('store_id', storeIds);
            } else {
                sel = sel.limit(500);
            }

            const { data, error } = await sel;
            if (error) { console.warn('[presets] load error', error); return; }

            const next: Record<string, StorePresetInfo> = {};
            // 既知の store を初期化
            for (const sid of storeIds) next[sid] = { current: currentById.get(sid) ?? null, slots: {} };

            for (const row of (data || []) as any[]) {
                const sid = String(row.store_id);
                if (!next[sid]) next[sid] = { current: currentById.get(sid) ?? null, slots: {} };
                next[sid].slots[Number(row.slot_no)] = {
                    name: (row.name || '').trim() || `プリセット${row.slot_no}`,
                    start: String(row.start_time).slice(0, 5),
                    end: String(row.end_time).slice(0, 5),
                    step: Number(row.slot_minutes || 10),
                };
            }

            // 🔎 デバッグ（開発時のみ）
            if (process.env.NEXT_PUBLIC_DEBUG === '1') {
                const cnt = Object.keys(next).length;
                console.info('[presets] built stores:', cnt, next);
            }
            // ★ 強制ログ（env無関係）＋ window 公開
            console.info('[presets] built stores:', Object.keys(next).length, next);
            if (typeof window !== 'undefined') {
                (window as any).presetDebug = {
                    storeIds,
                    dbStores,
                    presets: next,
                };
            }
            setMap(next);
        })();

    }, [supabase, JSON.stringify(storeIds), JSON.stringify(dbStores)]);

    // ▼▼▼ ここから追加：プリセット＆現在スロットの Realtime 購読 ▼▼▼
    useEffect(() => {
        if (!supabase) return;

        // 1) store_pickup_presets（追加/更新/削除）
        const ch1 = (supabase as any)
            .channel('rt-store-pickup-presets')
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'store_pickup_presets' },
                (payload: any) => {
                    const row = (payload.new ?? payload.old ?? {}) as any;
                    const sid = String(row.store_id ?? '');
                    const no = Number(row.slot_no ?? 0);

                    setMap(prev => {
                        const next = { ...prev };
                        // ストアキーがなければ初期化
                        if (!next[sid]) next[sid] = { current: null, slots: {} };


                        // INSERT/UPDATE
                        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                            next[sid] = {
                                ...next[sid],
                                slots: {
                                    ...next[sid].slots,
                                    [no]: {
                                        name: (row.name || '').trim() || `プリセット${no}`,
                                        start: String(row.start_time).slice(0, 5),
                                        end: String(row.end_time).slice(0, 5),
                                        step: Number(row.slot_minutes || 10),
                                    }
                                }
                            };
                        }

                        // DELETE
                        if (payload.eventType === 'DELETE') {
                            const slots = { ...next[sid].slots };
                            delete slots[no];
                            next[sid] = { ...next[sid], slots };
                        }
                        return next;
                    });
                }
            )
            .subscribe();

        // 2) stores.current_pickup_slot_no（現在のスロット番号の変更）
        const ch2 = (supabase as any)
            .channel('rt-stores-current-slot')
            .on('postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'stores' },
                (payload: any) => {
                    const row = payload.new as any;
                    const sid = String(row.id ?? row.store_id ?? '');
                    const current = row.current_pickup_slot_no ?? null;

                    setMap(prev => {
                        const next = { ...prev };
                        if (!next[sid]) next[sid] = { current: null, slots: {} };
                        next[sid] = { ...next[sid], current };
                        return next;
                    });
                }
            )
            .subscribe();

        return () => {
            try { (supabase as any).removeChannel(ch1); } catch { }
            try { (supabase as any).removeChannel(ch2); } catch { }
        };
    }, [supabase]);
    // ▲▲▲ ここまで追加 ▲▲▲

    // ▼▼▼ フェールセーフのポーリング（Realtime 不達時の整合性担保）▼▼▼
    useEffect(() => {
        if (!supabase) return;
        if (!Array.isArray(storeIds) || storeIds.length === 0) return;

        const reload = async () => {
            try {
                // 現在スロット番号
                const curQ = await supabase
                    .from('stores')
                    .select('id,current_pickup_slot_no')
                    .in('id', storeIds as any);
                if (curQ.error) return;

                const currentById = new Map<string, number | null>();
                for (const s of curQ.data || []) currentById.set(String((s as any).id), (s as any).current_pickup_slot_no ?? null);

                // プリセット
                const preQ = await supabase
                    .from('store_pickup_presets')
                    .select('store_id,slot_no,name,start_time,end_time,slot_minutes')
                    .in('store_id', storeIds as any);
                if (preQ.error) return;

                const next: Record<string, StorePresetInfo> = {};
                for (const sid of storeIds) next[sid] = { current: currentById.get(sid) ?? null, slots: {} };
                for (const row of (preQ.data || []) as any[]) {
                    const sid = String(row.store_id);
                    if (!next[sid]) next[sid] = { current: currentById.get(sid) ?? null, slots: {} };
                    next[sid].slots[Number(row.slot_no)] = {
                        name: (row.name || '').trim() || `プリセット${row.slot_no}`,
                        start: String(row.start_time).slice(0, 5),
                        end: String(row.end_time).slice(0, 5),
                        step: Number(row.slot_minutes || 10),
                    };
                }
                setMap(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            } catch { /* noop */ }
        };

        // 初回は軽く遅延
        const t0 = setTimeout(reload, 1500);
        // 周期 15秒
        const t = setInterval(reload, 15000);
        const onVis = () => { if (document.visibilityState === 'visible') reload(); };
        document.addEventListener('visibilitychange', onVis);

        return () => {
            clearTimeout(t0);
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [supabase, JSON.stringify(storeIds)]);
    // ▲▲▲ ポーリング追加（TODO(req v2): 差分適用へ最適化） ▲▲▲


    // 商品が未指定 → 店舗の current → 1→2→3 の順で最初に存在するスロットを採用
    const pickupLabelFor = useCallback((storeId: string, productSlotNo?: number | null) => {
        const info = map[storeId];
        if (!info) return null;

        const candidates = [
            productSlotNo ?? null,
            info.current ?? null,
            1, 2, 3
        ].filter((v) => v != null) as number[];

        for (const no of candidates) {
            const slot = info.slots[no];
            if (slot) return `${slot.start}–${slot.end}`;
        }
        return null;
    }, [map]);

    return { presetMap: map, pickupLabelFor };
}



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


function BottomSheet({
    open,
    title,
    onClose,
    children,
}: {
    open: boolean;
    title?: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const startY = React.useRef(0);
    const currentY = React.useRef(0);
    const [dragY, setDragY] = React.useState(0);
    const [dragging, setDragging] = React.useState(false);

    const onBackdrop = React.useCallback(() => { onClose(); }, [onClose]);

    // ▼ ドラッグ操作は“上部ハンドル領域だけ”で受ける
    const onTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0];
        startY.current = t.clientY;
        currentY.current = t.clientY;
        setDragging(true);
    };
    const onTouchMove = (e: React.TouchEvent) => {
        if (!dragging) return;
        const t = e.touches[0];
        currentY.current = t.clientY;
        const dy = Math.max(0, currentY.current - startY.current);
        setDragY(dy);
        e.preventDefault(); // ← ハンドル内のみなので内部フォーム/iframeのスクロールは邪魔しない
    };
    const onTouchEnd = () => {
        setDragging(false);
        if (dragY > 120) { onClose(); setDragY(0); return; }
        setDragY(0);
    };

    if (!open) return null;

    return (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[3000]">
            {/* 背景 */}
            <div className="absolute inset-0 bg-black/40" onClick={onBackdrop} aria-hidden />
            {/* シート位置 */}
            <div className="absolute inset-x-0 bottom-0 flex justify-center pointer-events-none">
                {/* シート本体 */}
                <div
                    className={`
            pointer-events-auto w-full max-w-[520px]
            rounded-t-2xl bg-white shadow-xl border-t
            touch-pan-y overscroll-contain
            max-h-[90vh] overflow-hidden
            ${dragging ? "" : "transition-transform duration-300"}
          `}
                    style={{ transform: `translateY(${dragY}px)` }}
                >
                    {/* ハンドル＋ヘッダー（ここだけがドラッグ対象） */}
                    <div
                        className="py-2 grid place-items-center select-none"
                        onTouchStart={onTouchStart}
                        onTouchMove={onTouchMove}
                        onTouchEnd={onTouchEnd}
                    >
                        <div aria-hidden className="h-1.5 w-12 rounded-full bg-zinc-300" />
                    </div>
                    <div
                        className="px-4 pb-2 flex items-center justify-between select-none"
                        onTouchStart={onTouchStart}
                        onTouchMove={onTouchMove}
                        onTouchEnd={onTouchEnd}
                    >
                        <div className="text-sm font-semibold">{title || ""}</div>
                        <button
                            type="button"
                            aria-label="閉じる"
                            className="w-8 h-8 rounded-full border bg-white hover:bg-zinc-50"
                            onClick={onClose}
                        >✕</button>
                    </div>

                    {/* コンテンツ：ここは自由にスクロールできる */}
                    <div
                        className="px-0 pb-3 overflow-auto"
                        style={{ maxHeight: "calc(90vh - 64px)" }} // 64px ≒ ハンドル＋ヘッダー分
                    >
                        {children}
                    </div>

                    {/* iOSホームバー対策 */}
                    <div className="h-4" />
                </div>
            </div>
        </div>
    );
}


export default function UserPilotApp() {

    // 保存済みカードの一覧（必要に応じてAPI連携に差し替え可：いまはデモ用）
    const savedCards = useMemo(
        () => [
            { id: "card_4242", brand: "Visa", last4: "4242" },
            { id: "card_1881", brand: "Mastercard", last4: "1881" },
        ],
        []
    );

    // 「別のカードを使う」クリックで従来フォームを開くトグル
    const [showCardFullForm, setShowCardFullForm] = useState(false);


    const [checkoutClientSecret, setCheckoutClientSecret] = useState<string | null>(null);
    const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);

    // コンポーネント“内”で再定義（①で削除したものの正しい版）
    const updateCardLabel = useCallback((digits: string) => {
        const v = validateTestCard(digits);
        setSelectedPayLabel(v.ok ? ((v as any).brand || "クレジットカード") : null);
    }, []);

    // 永続化
    const [shops, setShops] = useLocalStorageState<Shop[]>(K.shops, seedShops);
    const [cart, setCart] = useLocalStorageState<CartLine[]>(K.cart, []);
    // item が無い / 価格が数値でない / qty が数値でない行を除去（localStorage 移行時の破損対策）
    useEffect(() => {
        setCart(cs =>
            (cs || []).filter(l =>
                l &&
                typeof l.shopId === "string" &&
                l.item &&
                typeof l.item.price === "number" && !Number.isNaN(l.item.price) &&
                typeof l.qty === "number" && !Number.isNaN(l.qty)
            )
        );
    }, [setCart]);

    const [orders, setOrders] = useLocalStorageState<Order[]>(K.orders, []);
    const [pickupByGroup, setPickupByGroup] = useState<Record<string, PickupSlot | null>>({});


    const [userEmail] = useLocalStorageState<string>(K.user, "");
    const [tab, setTab] = useState<"home" | "cart" | "order" | "account">("home");





    // ▼「カートを見る」から目的店舗へスクロールするための待ち合わせ用
    const [pendingScrollShopId, setPendingScrollShopId] = useState<string | null>(null);
    // 直近でフォーカス対象となった店舗ID（補正スクロール用）
    const lastCartTargetIdRef = useRef<string | null>(null);
    // ▼ カート内の各「店舗先頭グループ」を指すアンカー（storeId -> 要素）
    const cartStoreAnchorRefs = useRef<Record<string, HTMLDivElement | null>>({});


    // 並び替えモード（ローカル保存）
    const [sortMode, setSortMode] = useLocalStorageState<'distance' | 'price'>('home_sort_mode', 'distance');

    // 店舗の「並び替え用 最安値」を算出（販売可能な商品に限定）
    const shopMinPrice = (s: Shop): number => {
        const now = Date.now();
        const eligibles = (s.items || []).filter((it) => {
            const notExpired = !isPickupExpired(it.pickup);
            const notFuture = it.publish_at ? (Date.parse(it.publish_at) <= now) : true;
            const hasStock = (it.stock ?? 0) > 0;
            return notExpired && notFuture && hasStock;
        });
        if (eligibles.length === 0) return Number.POSITIVE_INFINITY;
        return Math.min(...eligibles.map((it) => Number(it.price || 0)));
    };

    // タブの直前値を覚えておく
    const prevTabRef = useRef<typeof tab>(tab);

    // 既存の state 定義のすぐ後あたりに追加
    useEffect(() => {
        // item が無い / 価格が数値でない / qty が数値でない行を除去
        setCart(cs =>
            cs.filter(l =>
                l && typeof l.shopId === 'string' &&
                l.item && typeof l.item.price === 'number' && !Number.isNaN(l.item.price) &&
                typeof l.qty === 'number' && !Number.isNaN(l.qty)
            )
        );
    }, [setCart]);

    // タブが変わったら実行（cart → それ以外 になった時にだけ掃除）
    useEffect(() => {
        const prev = prevTabRef.current;
        if (prev === 'cart' && tab !== 'cart') {
            setCart(cs => cs.filter(l => l.qty > 0));
        }
        prevTabRef.current = tab;
    }, [tab, setCart]);

    // 補正スクロール向けに、最後に指定された店舗IDを保持
    useEffect(() => {
        if (pendingScrollShopId) {
            lastCartTargetIdRef.current = pendingScrollShopId;
        }
    }, [pendingScrollShopId]);

    // 販売時間切れのカート行を間引く（60秒ごと + 即時1回）
    useEffect(() => {
        const prune = () => {
            setCart(cs => {
                const kept = cs.filter(l => !isPickupExpired(l.item.pickup));
                if (kept.length !== cs.length) {
                    emitToast("info", "販売時間を過ぎた商品をカートから削除しました");
                }
                return kept;
            });
        };
        prune(); // 初回即時
        const id = window.setInterval(prune, 60_000);
        return () => window.clearInterval(id);
    }, [setCart]);


    // カート画面を開いたタイミングでも即時掃除
    useEffect(() => {
        if (tab !== "cart") return;
        setCart(cs => {
            const kept = cs.filter(l => !isPickupExpired(l.item.pickup));
            if (kept.length !== cs.length) {
                emitToast("info", "販売時間を過ぎた商品をカートから削除しました");
            }
            return kept;
        });
    }, [tab, setCart]);


    // 「カートを見る」から遷移したら、目的店舗の先頭カートへスクロール（ヘッダー分を差し引いて位置補正）
    useEffect(() => {
        if (tab !== 'cart') return;
        if (!pendingScrollShopId) return;

        // レイアウト確定後にスクロール（2段階 rAF で描画完了を待つ）

        const run = () => {
            const el = cartStoreAnchorRefs.current[pendingScrollShopId!];
            if (el) {
                // ヘッダーの実高さ＋少し余白（8px）を差し引いてスクロール
                const header = document.querySelector('header') as HTMLElement | null;
                const headerH = header ? header.getBoundingClientRect().height : 0;
                const GAP = 8; // ← ここを変えると表示位置の余白を微調整できます
                const y = el.getBoundingClientRect().top + window.scrollY - headerH - GAP;
                window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
            }
            setPendingScrollShopId(null);
        };
        requestAnimationFrame(() => requestAnimationFrame(run));
        return;
    }, [tab, pendingScrollShopId]);

    // Cart view scroll correction: re-align target anchor after late layout shifts
    useEffect(() => {
        if (tab !== 'cart') return;
        const correct = () => {
            const anchors = Object.values(cartStoreAnchorRefs.current).filter(Boolean) as HTMLDivElement[];
            if (anchors.length === 0) return;
            const header = document.querySelector('header') as HTMLElement | null;
            const headerH = header ? header.getBoundingClientRect().height : 0;
            const GAP = 8;
            // 可能なら直近ターゲットのアンカーを優先
            const preferred = lastCartTargetIdRef.current ? cartStoreAnchorRefs.current[lastCartTargetIdRef.current] : null;
            const targetEl = preferred || anchors.reduce<HTMLDivElement | null>((acc, el) => {
                if (!acc) return el;
                const a = Math.abs(el.getBoundingClientRect().top - (headerH + GAP));
                const b = Math.abs(acc.getBoundingClientRect().top - (headerH + GAP));
                return a < b ? el : acc;
            }, null);
            if (!targetEl) return;
            const y = targetEl.getBoundingClientRect().top + window.scrollY - headerH - GAP;
            window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
        };
        const t1 = window.setTimeout(correct, 320);
        const t2 = window.setTimeout(correct, 950);
        return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    }, [tab]);


    const [focusedShop, setFocusedShop] = useState<string | undefined>(undefined);
    const [detail, setDetail] = useState<{ shopId: string; item: Item } | null>(null);
    const [allergyOpen, setAllergyOpen] = useState(false);
    // 商品詳細モーダル・ギャラリー用（ネイティブ touch を非パッシブで束ねる）
    const carouselWrapRef = useRef<HTMLDivElement | null>(null);
    const touchStateRef = useRef<{ sx: number; sy: number } | null>(null);

    // 画面全体のスクロールを、詳細モーダル or 決済シートが開いている間はロック
    useLockBodyScroll(!!detail || isCheckoutOpen);
    const detailImages = useMemo<string[]>(() => {
        if (!detail?.item) return [];
        return [
            detail.item.main_image_path,
            detail.item.sub_image_path1,
            detail.item.sub_image_path2,
        ].filter((x): x is string => !!x);
    }, [detail]);



    // ギャラリー（モーダル）state
    const [gallery, setGallery] = useState<null | { name: string; paths: string[] }>(null);
    const [gIndex, setGIndex] = useState(0);
    // ループ用に左右にクローンを1枚ずつ追加したトラック位置
    // pos は 0..imgCount+1 を取り、1 が「本来の先頭」
    const [pos, setPos] = useState(1);
    const [anim, setAnim] = useState(false); // true のときだけ CSS transition を効かせる
    const targetIndexRef = useRef(0);        // 次に確定させる gIndex（transition 終了タイミングで反映）

    // クローン付き画像配列 [last, ...detailImages, first]
    const loopImages = useMemo(() => {
        if (detailImages.length === 0) return [];
        return [
            detailImages[detailImages.length - 1],
            ...detailImages,
            detailImages[0],
        ];
    }, [detailImages]);

    const imgCount = detailImages.length;

    // 詳細を開いた / 画像セットが変わったときにリセット
    useEffect(() => {
        if (!detail || imgCount === 0) return;
        setGIndex(0);
        setPos(1);       // 先頭の実画像に対応する位置
        setAnim(false);  // トラックを一瞬で所定位置へ
    }, [detail, imgCount]);

    // 表示用URL生成
    const getImgUrl = useCallback((idx: number) =>
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${detailImages[idx]}`,
        [detailImages]
    );

    // 画像プリロード（失敗しても resolve）
    const preloadImage = useCallback((url: string) => new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = url;
    }), []);





    const supabase = useSupabase();
    type DbProduct = { id: string; store_id?: string; name: string; price?: number; stock?: number; image_url?: string; updated_at?: string, pickup_slot_no?: number | null; publish_at?: string | null; };
    type DbStore = {
        id: string; name: string; created_at?: string;
        lat?: number; lng?: number; address?: string;
        cover_image_path?: string | null;
        current_pickup_slot_no?: number | null;
        tel?: string | null;          // ★ 追加
        url?: string | null;          // ★ 追加
        hours?: string | null;    // ★ 追加
        holiday?: string | null;  // ★ 追加
        category?: string | null; // ★ 追加
        note?: string | null;
        gmap_embed_src?: string | null;   // ★ 追加
        gmap_url?: string | null;         // ★ 追加（任意）
        place_id?: string | null;         // ★ 追加（任意）
    };

    const [dbProducts, setDbProducts] = useState<DbProduct[]>([]);
    // 予約公開の到来で“即時”に再評価するためのトリガ
    const pubTimerRef = useRef<number | null>(null);
    const [pubWake, setPubWake] = useState(0);

    // publish_at（未来）→ 到来した瞬間に軽く再レンダーして一覧へ反映
    useEffect(() => {
        // 既存のタイマがあれば解除
        if (pubTimerRef.current) {
            window.clearTimeout(pubTimerRef.current);
            pubTimerRef.current = null;
        }

        // 未来の publish_at を抽出して最も近いものだけを待つ
        const now = Date.now();
        const future = (dbProducts || [])
            .map(p => p?.publish_at ? Date.parse(p.publish_at) : NaN)
            .filter(ts => Number.isFinite(ts) && ts > now)
            .sort((a, b) => a - b);

        if (future.length === 0) return; // 次が無ければ何もしない

        const delay = Math.max(0, future[0] - now) + 300; // 300ms マージン
        pubTimerRef.current = window.setTimeout(() => {
            // 軽い再レンダー（shopsWithDb の useMemo を再評価させる）
            setPubWake(Date.now());
        }, delay);

        // クリーンアップ
        return () => {
            if (pubTimerRef.current) {
                window.clearTimeout(pubTimerRef.current);
                pubTimerRef.current = null;
            }
        };
    }, [dbProducts]);


    const [dbStores, setDbStores] = useState<DbStore[]>([]);
    const { presetMap, pickupLabelFor } = useStorePickupPresets(supabase, dbStores as any[], dbProducts as any[]);
    // ★ Console から直接呼べるように公開
    if (typeof window !== 'undefined') {
        (window as any).pickupTest = (sid: string, slot?: number | null) => pickupLabelFor(sid, slot ?? null);
        (window as any).presetMap = presetMap;
    }



    // ギャラリー移動（無限ループ）

    const goPrev = useCallback(() => {
        if (imgCount <= 1 || anim) return;
        const nextIndex = (gIndex - 1 + imgCount) % imgCount;
        targetIndexRef.current = nextIndex;
        setAnim(true);
        setPos(p => p - 1); // 0 に到達したら onTransitionEnd でクローズアップ修正
    }, [imgCount, anim, gIndex]);

    const goNext = useCallback(() => {
        if (imgCount <= 1 || anim) return;
        const nextIndex = (gIndex + 1) % imgCount;
        targetIndexRef.current = nextIndex;
        setAnim(true);
        setPos(p => p + 1); // imgCount+1 に到達したら onTransitionEnd で修正
    }, [imgCount, anim, gIndex]);

    // タッチ操作（非パッシブ）をネイティブで束ねる：黒画面/チラつき/3枚目で止まる問題を解消
    useEffect(() => {
        const el = carouselWrapRef.current;
        if (!detail || !el) return;

        const onStart = (e: TouchEvent) => {
            const t = e.touches[0];
            touchStateRef.current = { sx: t.clientX, sy: t.clientY };
        };

        const onMove = (e: TouchEvent) => {
            const st = touchStateRef.current;
            if (!st) return;
            const t = e.touches[0];
            const dx = t.clientX - st.sx;
            const dy = t.clientY - st.sy;
            // 水平優位ならスクロールを抑止（※ passive:false なので preventDefault 可）
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
                e.preventDefault();
            }
        };

        const onEnd = (e: TouchEvent) => {
            const st = touchStateRef.current;
            touchStateRef.current = null;
            if (!st) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - st.sx;
            const dy = t.clientY - st.sy;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
                if (dx > 0) { goPrev(); } else { goNext(); }
            }
        };

        // 🔑 passive:false がポイント
        el.addEventListener('touchstart', onStart, { passive: false });
        el.addEventListener('touchmove', onMove, { passive: false });
        el.addEventListener('touchend', onEnd, { passive: false });

        return () => {
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchmove', onMove);
            el.removeEventListener('touchend', onEnd);
        };
    }, [detail, goPrev, goNext]);



    // ←→ キーでも移動
    useEffect(() => {
        if (!detail || imgCount <= 1) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
            if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [detail, imgCount, goPrev, goNext]);


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
    useEffect(() => { if (detail) { setGIndex(0); setAllergyOpen(false); } }, [detail, setGIndex]);

    const [clock, setClock] = useState<string>("");
    useEffect(() => {
        const tick = () => setClock(new Date().toLocaleTimeString());
        tick();
        const id = setInterval(tick, 30_000);
        return () => clearInterval(id);
    }, []);

    // Googleマップの遷移先URL（place_id 最優先 → 既存のフォールバック）
    const googleMapsUrlForShop = (s: Shop) => {
        // 0) place_id があれば最優先（名前を query に同梱して確実に“ピン選択”を起動）
        const pid = s.place_id && String(s.place_id).trim();
        if (pid) {
            const label = (s.name || "").trim() || "場所";
            // A: 推奨（公式ドキュメント系の安定パターン）
            return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}&query_place_id=${encodeURIComponent(pid)}`;
            // B: もし上でピンが出ない端末がある場合は、こちらに切り替えてもOK
            // return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pid)}`;
        }

        // 1) 埋め込み src → ピン付きURL
        const fromEmbedUrl = mapsUrlFromEmbedForNewTab(s.gmap_embed_src ?? null, s.name as any);
        if (fromEmbedUrl) return fromEmbedUrl;

        // 2) 共有URLから座標
        const fromShare = extractLatLngFromGoogleUrl(s.gmap_url ?? undefined);
        if (fromShare) {
            return `https://www.google.com/maps/search/?api=1&query=${fromShare.lat},${fromShare.lng}`;
        }

        // 3) 共有URLそのまま
        if (s.gmap_url) return s.gmap_url;

        // 4) 住所
        if (s.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`;

        // 5) DBのlat/lng
        if (typeof s.lat === "number" && typeof s.lng === "number") {
            return `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
        }
        return "https://www.google.com/maps";
    };



    // DBから products を読む（全店舗分を取得し、後段で store_id ごとにグルーピング）
    useEffect(() => {
        if (!supabase) return;
        (async () => {
            const q = supabase
                .from("products")
                .select("id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note")
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

    // フェールセーフ: products のポーリング再取得（Realtime 不達時の整合性担保）
    // TODO(req v2): 本番では ETag/If-Modified-Since 等による差分取得や
    //               updated_at によるインクリメンタル取得へ最適化する。
    useEffect(() => {
        if (!supabase) return;

        let disposed = false;

        const fetchAll = async () => {
            try {
                const { data, error } = await supabase
                    .from("products")
                    .select("id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note");
                if (disposed) return;
                if (error) {
                    // 取得失敗は静かにスキップ（次周期で再試行）
                    if (DEBUG) console.warn('[products:poll] error', error);
                    return;
                }
                setDbProducts(Array.isArray(data) ? data : []);
            } catch (e) {
                if (DEBUG) console.warn('[products:poll] exception', e);
            }
        };

        // 初回は軽く待ってから整合チェック（Realtime 即時反映と競合しにくくする）
        const t0 = setTimeout(fetchAll, 1500);
        // 周期ポーリング（10秒）
        const t = setInterval(fetchAll, 10000);

        // タブ復帰時も即座に整合を取りに行く
        const onVis = () => { if (document.visibilityState === 'visible') fetchAll(); };
        document.addEventListener('visibilitychange', onVis);

        return () => {
            disposed = true;
            clearTimeout(t0);
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [supabase]);





    // DBから stores を読む（全件・上限あり）
    useEffect(() => {
        if (!supabase) return;
        (async () => {
            // 置き換え
            const { data, error } = await supabase
                .from("stores")
                .select("id, name, created_at, lat, lng, address, cover_image_path, current_pickup_slot_no, tel, url, hours, holiday, category, gmap_embed_src, gmap_url, place_id") // ★ 追加
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

            const sid = String(p?.store_id ?? "");
            const pick = pickupLabelFor(sid, (p as any)?.pickup_slot_no ?? null) || "—";

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
                pickup: pick,                  // ← ここがDB由来になる
                note: String(p?.note ?? "").slice(0, 300),
                photo: "🛍️",
                main_image_path: primary,
                sub_image_path1: p?.sub_image_path1 ?? null,
                sub_image_path2: p?.sub_image_path2 ?? null,
                publish_at: p?.publish_at ?? null,
            };
        };



        const fallback = { lat: 35.171, lng: 136.881 }; // 名古屋駅など任意
        // 置き換え（該当ブロック内に追記）
        const built: Shop[] = dbStores.map((st) => ({
            id: String(st.id),
            name: String(st.name ?? "店舗"),
            lat: typeof st.lat === "number" ? st.lat : fallback.lat,
            lng: typeof st.lng === "number" ? st.lng : fallback.lng,
            zoomOnPin: 16,
            closed: false,
            items: (byStore.get(String(st.id)) || [])
                .filter((raw: any) => isPublishedNow(raw?.publish_at))
                .map(mapToItem),
            address: typeof st.address === "string" ? st.address : undefined,
            cover_image_path: st.cover_image_path ?? null,
            tel: (st.tel ?? undefined) as string | undefined,     // ★ 追加
            url: (st.url ?? undefined) as string | undefined,     // ★ 追加
            hours: (st.hours ?? undefined) as string | undefined,       // ★ 追加
            holiday: (st.holiday ?? undefined) as string | undefined,   // ★ 追加
            category: (st.category ?? undefined) as string | undefined, // ★ 追加
            gmap_embed_src: st.gmap_embed_src ?? null,
            gmap_url: st.gmap_url ?? null,
            place_id: st.place_id ?? null,
        }));


        setShops(prev => (JSON.stringify(prev) === JSON.stringify(built) ? prev : built));
    }, [dbStores, dbProducts, presetMap, setShops, pubWake]);


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

    // 現在地（ユーザー端末）
    const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
    const [locState, setLocState] = useState<'idle' | 'getting' | 'ok' | 'error'>('idle');
    const [locError, setLocError] = useState<string | null>(null);

    const requestLocation = useCallback(() => {
        if (typeof window === 'undefined') return;
        if (!('geolocation' in navigator)) {
            setLocState('error');
            setLocError('この端末は位置情報に対応していません');
            emitToast('error', '位置情報に対応していません');
            return;
        }
        setLocState('getting');
        setLocError(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                setLocState('ok');
            },
            (err) => {
                setLocState('error');
                setLocError(err?.message || '位置情報の取得に失敗しました');
                emitToast('error', '位置情報の取得に失敗しました');
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 }

        );
    }, []);

    // ▼ 初回マウント時に権限状態を確認し、許可済み or 未決定なら「一度だけ」現在地取得を試行
    useEffect(() => {
        if (typeof window === 'undefined') return; // SSR対策
        if (!('geolocation' in navigator)) {
            setLocState('error');
            setLocError('この端末は位置情報に対応していません');
            return;
        }

        // 多重起動を避ける（すでにOK or 取得中なら何もしない）
        const tryOnce = () => {
            if (locState === 'ok' || locState === 'getting' || myPos) return;
            requestLocation(); // ここで初回だけ getCurrentPosition を発火（"prompt" なら許可ダイアログが出る）
        };

        // Permissions API が使えるなら状態を見て分岐
        const navAny = navigator as any;
        if (navAny.permissions?.query) {
            navAny.permissions
                .query({ name: 'geolocation' as PermissionName })
                .then((status: PermissionStatus) => {
                    if (status.state === 'granted' || status.state === 'prompt') {
                        tryOnce();
                    } else if (status.state === 'denied') {
                        // 既に拒否されている場合は自動取得は行わず、UIに案内だけ出す
                        setLocState('error');
                        setLocError('位置情報へのアクセスがブロックされています。ブラウザの設定から許可してください。');
                    }
                    // 設定変更に追従（タブを開いたまま許可→即取得）
                    status.onchange = () => {
                        if (status.state === 'granted') tryOnce();
                    };
                })
                .catch(() => {
                    // Permissions API 非対応やエラー時はフォールバック：一度だけ実行
                    tryOnce();
                });
        } else {
            // Permissions API 非対応（Safariなど）→ フォールバック
            tryOnce();
        }
        // 依存に requestLocation / locState / myPos を入れておけば、
        // 権限変更→granted時などにも一度だけ再試行されます
    }, [requestLocation, locState, myPos]);


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
            const rawStock = (p?.stock ?? p?.quantity ?? p?.stock_count ?? 0);
            const stock = Math.max(0, Number(rawStock) || 0);

            const sid = String(p?.store_id ?? storeId ?? "");
            const pick = sid ? (pickupLabelFor(sid, (p as any)?.pickup_slot_no ?? null) || "—") : "—";

            return {
                id: String(p.id),
                name: String(p.name ?? "商品"),
                price: Math.max(0, Number(p.price ?? 0) || 0),
                stock,
                pickup: pick,     // ← DBのプリセット由来へ
                note: String(p?.note ?? "").slice(0, 300),
                photo: "🛍️",
                publish_at: p?.publish_at ?? null,
            };
        };

        // shops[].id が UUID でない（ローカルID）場合のフォールバック：最初のショップに適用
        const idx = shops.findIndex(s => String(s.id) === String(storeId));
        const targetIndex = idx >= 0 ? idx : 0;

        return shops.map((s, i) =>
            i === targetIndex ? {
                ...s, items: dbProducts
                    .filter((p: any) => isPublishedNow(p?.publish_at))
                    .map(mapToItem),
            } : s
        );

        // プリセットが来たら再計算
    }, [shops, dbProducts, storeId, dbStores, presetMap, pubWake]);

    // 店舗ごとの「距離計算用座標」を一度だけ抽出してメモ化
    const coordsByStore = useMemo(() => {
        const m = new Map<string, { lat: number; lng: number }>();
        for (const s of shopsWithDb) {
            const ll = bestLatLngForDistance(s);
            if (ll) m.set(s.id, ll);
        }
        return m;
    }, [shopsWithDb]);

    type ShopForSort = Shop & { distance: number; minPrice: number };

    // ルート距離のキャッシュ（store.id -> km）
    const [routeKmByStore, setRouteKmByStore] = useState<Record<string, number>>({});

    // ルート距離のキャッシュ（localStorage 永続）
    const distanceCacheRef = useRef<Record<string, number>>({});

    // 初期ロード：localStorage から復元
    useEffect(() => {
        try {
            distanceCacheRef.current = JSON.parse(localStorage.getItem('route_dist_cache_v1') || '{}');
        } catch {/* noop */ }
    }, []);

    // 変更が入るたびに永続化
    useEffect(() => {
        try {
            localStorage.setItem('route_dist_cache_v1', JSON.stringify(distanceCacheRef.current));
        } catch {/* noop */ }
    }, [routeKmByStore]);

    // 2点を対称キーに（往復同値）。位置は約100mでスナップしてキーを安定化
    const keyForPair = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
        const r = (x: number) => x.toFixed(3); // 3桁=約100m
        const ka = `${r(a.lat)},${r(a.lng)}`;
        const kb = `${r(b.lat)},${r(b.lng)}`;
        return ka < kb ? `${ka}|${kb}|walk` : `${kb}|${ka}|walk`;
    };

    // 所要時間（徒歩/車）ラベル：ルート距離が出るまで「距離算定中」
    const travelTimeLabelFor = useCallback((s: ShopForSort | Shop): { icon: string; text: string } => {
        const target = bestLatLngForDistance(s as Shop);
        if (!myPos || !target) return { icon: "🚶", text: "—" };
        const rk = routeKmByStore[s.id as string]; // km（OSRM）
        if (rk == null) {
            // OSRM の結果が未取得/失敗の場合は概算（直線距離ベース）で即時表示
            const approx = haversineKm(myPos, target);
            if (!Number.isFinite(approx)) return { icon: "🚶", text: "—" };
            const walkMin = Math.max(1, Math.ceil(approx * 15));
            if (walkMin <= 15) return { icon: "🚶", text: `徒歩約${walkMin}分` };
            const carMin = Math.max(1, Math.ceil((approx * 60) / 35));
            return { icon: "🚗", text: `所要約${carMin}分` };
        }

        // 徒歩（4km/h）= 1kmあたり15分
        const walkMin = Math.max(1, Math.ceil(rk * 15));
        if (walkMin <= 15) return { icon: "🚶", text: `徒歩${walkMin}分` };

        // 車（35km/h）= 1kmあたり約1.714分
        const carMin = Math.max(1, Math.ceil((rk * 60) / 35));
        return { icon: "🚗", text: `所要${carMin}分` };
    }, [myPos, routeKmByStore]);


    // 表示用の距離文言
    const distanceLabelFor = useCallback((s: ShopForSort | Shop): string => {
        const target = bestLatLngForDistance(s as Shop);
        if (!myPos || !target) return '—';
        const rk = routeKmByStore[s.id as string];
        if (rk != null) return `${rk.toFixed(2)} km`;
        // ルート距離がまだ無い場合は直線距離の概算を表示（UX 向上）
        const approx = haversineKm(myPos, target);
        return Number.isFinite(approx) ? `約${approx.toFixed(2)} km` : '—';
    }, [myPos, routeKmByStore]);

    // myPos と候補店舗に基づき、OSRM で徒歩ルート距離を取得（並列・キャッシュ即時反映）
    useEffect(() => {
        if (!myPos) return;

        // 1) 距離対象を作成（座標がある店舗だけ）
        const targets = shopsWithDb
            .map((s) => ({ s, target: coordsByStore.get(s.id) || bestLatLngForDistance(s) }))
            .filter((x): x is { s: Shop; target: { lat: number; lng: number } } => !!x.target);

        if (targets.length === 0) return;

        // 2) まずはキャッシュから即時で埋められる分を反映
        const toFillFromCache: Array<[string, number]> = [];
        for (const { s, target } of targets) {
            if (routeKmByStore[s.id] != null) continue;
            const k = keyForPair(myPos, target);
            const cached = distanceCacheRef.current[k];
            if (typeof cached === 'number' && Number.isFinite(cached)) {
                toFillFromCache.push([s.id, cached]);
            }
        }
        if (toFillFromCache.length > 0) {
            setRouteKmByStore(prev => ({ ...prev, ...Object.fromEntries(toFillFromCache) }));
        }


        // 3) まだ欠けているものだけ取得（上限: 20件／回）
        const pending = targets
            .filter(({ s }) => routeKmByStore[s.id] == null && !toFillFromCache.find(([id]) => id === s.id))
            .slice(0, 20);

        if (pending.length === 0) return;

        // 4) 並列取得（同時最大 8）
        const ac = new AbortController();
        let cancelled = false;
        (async () => {
            const MAX_PAR = 8;

            // 小さめバッチに分割
            const batches: Array<typeof pending> = [];
            for (let i = 0; i < pending.length; i += MAX_PAR) {
                batches.push(pending.slice(i, i + MAX_PAR));
            }

            const allEntries: Array<[string, number]> = [];
            for (const batch of batches) {
                if (cancelled) break;
                const results = await Promise.all(batch.map(async ({ s, target }) => {
                    const km = await routeDistanceKm(myPos, target, 'walking'); // 既存の関数を利用
                    return { id: s.id, target, km };
                }));

                for (const r of results) {
                    if (!cancelled && typeof r.km === 'number') {
                        allEntries.push([r.id, r.km]);
                        // キャッシュ保存
                        const k = keyForPair(myPos, r.target);
                        distanceCacheRef.current[k] = r.km;
                    }
                }
            }

            if (!cancelled && allEntries.length > 0) {
                setRouteKmByStore(prev => ({ ...prev, ...Object.fromEntries(allEntries) }));
            }
        })();

        return () => {
            cancelled = true;
            ac.abort();
        };
    }, [myPos, shopsWithDb, coordsByStore, routeKmByStore, setRouteKmByStore]);


    const shopsSorted = useMemo<ShopForSort[]>(() => {
        const withKeys = shopsWithDb.map((s) => {
            const target = bestLatLngForDistance(s);
            const d = (myPos && target)
                ? (routeKmByStore[s.id] ?? haversineKm(myPos, target))
                : Number.POSITIVE_INFINITY;
            const p = shopMinPrice(s);
            return { ...s, distance: d, minPrice: p };
        });

        if (sortMode === 'price') {
            // 価格の安い順 → 同値は距離の近い順
            return withKeys.sort((a, b) =>
                (a.minPrice - b.minPrice) || (a.distance - b.distance)
            );
        } else {
            // 距離の近い順 → 同値は価格の安い順
            return withKeys.sort((a, b) =>
                (a.distance - b.distance) || (a.minPrice - b.minPrice)
            );
        }
    }, [shopsWithDb, myPos, sortMode, routeKmByStore]);




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

    // カート整合: products の変更/削除を反映（価格/名称/在庫/受取枠など）
    // - UPDATE: 該当商品の item を最新に置換。数量は在庫でクランプ
    // - DELETE/非公開: カートから除去
    useEffect(() => {
        setCart(prev => {
            if (!prev || prev.length === 0) return prev;

            let changed = false;
            let removed = 0;
            let clamped = 0;

            const next: CartLine[] = [];
            for (const l of prev) {
                const map = itemsById.get(l.shopId);
                const latest = map?.get(l.item.id);
                if (!latest) {
                    // 商品が削除 or 非公開になった
                    removed++;
                    changed = true;
                    continue;
                }
                const newQty = Math.max(0, Math.min(latest.stock, l.qty));
                if (newQty !== l.qty) { clamped++; }

                // item の差分がある場合は置換
                const sameItem = (
                    l.item.id === latest.id &&
                    l.item.name === latest.name &&
                    l.item.price === latest.price &&
                    l.item.stock === latest.stock &&
                    l.item.pickup === latest.pickup &&
                    l.item.main_image_path === latest.main_image_path &&
                    l.item.sub_image_path1 === latest.sub_image_path1 &&
                    l.item.sub_image_path2 === latest.sub_image_path2 &&
                    l.item.publish_at === latest.publish_at &&
                    l.item.note === latest.note
                );


                if (!sameItem || newQty !== l.qty) changed = true;
                next.push({ shopId: l.shopId, item: latest, qty: newQty });
            }

            if (changed) {
                if (removed > 0) emitToast('info', `商品が削除（または非公開）されたため、${removed}件をカートから除外しました`);
                if (clamped > 0) emitToast('info', `在庫変更により、${clamped}件の数量を調整しました`);
                return next;
            }
            return prev;
        });
    }, [itemsById, setCart]);


    // 予約数量（カート数量）
    const reservedMap = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of cart) { const k = `${c.shopId}:${c.item.id}`; m.set(k, (m.get(k) || 0) + c.qty); }
        return m;
    }, [cart]);
    const getReserved = (sid: string, itemId: string) => reservedMap.get(`${sid}:${itemId}`) || 0;

    // === ここから「店舗ID＋受取時間グループ」版 ===

    // 店舗→行 の一次グルーピング（これは従来どおり）
    const cartByStore = useMemo(() => {
        const g: Record<string, CartLine[]> = {};
        for (const l of cart) {
            if (!l || !l.shopId || !l.item) continue;
            g[l.shopId] ||= [];
            g[l.shopId].push(l);
        }
        return g;
    }, [cart]);

    // 店舗ごとに「受取時間オーバーラップ」で二次グルーピング
    const cartGroups = useMemo(() => {
        const out: Record<string, CartGroup> = {};
        for (const sid of Object.keys(cartByStore)) {
            const groups = groupCartLinesByPickup(cartByStore[sid]);
            for (const g of groups) out[g.key] = g;
        }
        return out;
    }, [cartByStore]);

    // 金額と数量は「グループキー」単位で
    const totalsByGroup = useMemo(() => {
        const t: Record<string, number> = {};
        for (const key in cartGroups) {
            const lines = cartGroups[key]?.lines ?? [];
            t[key] = lines.reduce((a, l) => {
                const price = Number(l?.item?.price ?? 0);
                const qty = Number(l?.qty ?? 0);
                return a + (Number.isFinite(price) ? price : 0) * (Number.isFinite(qty) ? qty : 0);
            }, 0);
        }
        return t;
    }, [cartGroups]);


    const qtyByGroup = useMemo(() => {
        const q: Record<string, number> = {};
        for (const key in cartGroups) {
            const lines = cartGroups[key]?.lines ?? [];
            q[key] = lines.reduce((a, l) => a + (Number.isFinite(Number(l?.qty)) ? Number(l?.qty) : 0), 0);
        }
        return q;
    }, [cartGroups]);

    // 店舗ごとの数量合計（= 旧 qtyByShop 互換）
    const qtyByShop = useMemo(() => {
        const m: Record<string, number> = {};
        for (const gkey in qtyByGroup) {
            const sid = cartGroups[gkey]?.storeId;
            if (!sid) continue;
            m[sid] = (m[sid] || 0) + qtyByGroup[gkey];
        }
        return m;
    }, [qtyByGroup, cartGroups]);


    const groupTotal = (gkey: string) => totalsByGroup[gkey] || 0;


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
        const count = (cartByStore[sid]?.length ?? 0);
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
    // ▼ 支払い選択フロー（ボトムシート制御）
    const [isPayMethodOpen, setIsPayMethodOpen] = useState(false); // シート①：支払い方法の選択
    const [isCardEntryOpen, setIsCardEntryOpen] = useState(false); // シート②：カード番号入力
    const [selectedPayLabel, setSelectedPayLabel] = useState<string | null>(null); // 行に表示するラベル（例: "Visa(4242)"）
    // 支払い方法のタブ切り替え用（ボタンの見た目制御に使用）
    const [paymentMethod, setPaymentMethod] = useState<'card' | 'paypay' | null>(null);


    const [orderTarget, setOrderTarget] = useState<string | undefined>(undefined);
    const unredeemedOrders = useMemo(() => orders.filter(o => o.status === 'paid'), [orders]);
    const redeemedOrders = useMemo(() => orders.filter(o => o.status === 'redeemed'), [orders]);
    // テストカードのブランド表示（失敗/未入力は TEST 扱い）
    const payBrand = (() => {
        const r = validateTestCard(cardDigits);
        return (r as any).brand || 'TEST';
    })();


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

    // 受け取りグループ(gkey)をStripe Checkoutへ
    // 注文画面へ → Stripe PaymentElement を開く
    const startStripeCheckout = useCallback(async (targetKey?: string) => {
        const key = targetKey ?? orderTarget;
        if (!key) return;
        const g = cartGroups[key];
        if (!g || g.lines.length === 0) { emitToast("error", "カートが空です"); return; }

        const sel = pickupByGroup[key] ?? null;
        const pickupLabel = sel ? `${sel.start}〜${sel.end}` : "";

        const linesPayload = g.lines.map(l => ({
            id: l.item.id,
            name: l.item.name,
            price: Number(l.item.price) || 0,
            qty: Number(l.qty) || 0,
        })).filter(x => x.qty > 0);

        if (linesPayload.length === 0) { emitToast("error", "数量が0の商品です"); return; }

        try {
            setIsPaying(true);
            const res = await fetch("/api/stripe/create-checkout-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    storeId: g.storeId,
                    userEmail,
                    lines: linesPayload,
                    pickup: pickupLabel,
                    // 決済完了後の戻り先（Embedded Checkout 用）
                    // TODO(req v2): 成功ページでの決済検証/注文整合の拡張
                    returnUrl: `${location.origin}/checkout/success`,
                }),
            });

            // 404/HTMLエラー対策：常に text を一度読む
            const text = await res.text();
            if (!res.ok) throw new Error(text || "create-checkout-session 失敗");
            const json = JSON.parse(text);
            const cs: string | undefined = json?.client_secret;
            if (!cs) throw new Error("client_secret がありません");
            setCheckoutClientSecret(cs);
            setIsCheckoutOpen(true);
        } catch (e: any) {
            console.error(e);
            emitToast("error", e?.message || "Stripe セッション作成に失敗しました");
        } finally {
            setIsPaying(false);
        }
    }, [orderTarget, cartGroups, userEmail, pickupByGroup]);



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
            <div className="inline-flex items-center rounded-full px-0 py-1 text-sm select-none">
                <button
                    type="button"
                    className="w-7 h-7 text-[10px] leading-none rounded-full border cursor-pointer disabled:opacity-40 flex items-center justify-center"
                    disabled={reserved <= 0}
                    onClick={() => changeQty(sid, it, -1)}
                    aria-label="数量を減らす"
                >−</button>
                <span className="mx-1 min-w-[1.5rem] text-center tabular-nums">{reserved}</span>
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


    // noChrome=true のとき、外枠（rounded/border/bg）を外す
    // 共通：商品1行（ホーム/カートで再利用）
    const ProductLine = ({
        sid,
        it,
        noChrome = false,
        onRemove,
    }: {
        sid: string;
        it: Item;
        noChrome?: boolean;
        onRemove?: () => void;
    }) => {
        const reserved = getReserved(sid, it.id);
        const remain = Math.max(0, it.stock - reserved);
        // 「決済で在庫が引かれた（＝ products.stock が 0）」ときだけ Sold out を表示
        const isSoldOut = it.stock <= 0;


        const wrapBase = "relative flex gap-3 p-2 pr-3";
        const chrome = "rounded-2xl border bg-white";
        const wrapperCls = `${wrapBase} ${noChrome ? "" : chrome}`;

        return (
            <div className={`${wrapperCls} ${isSoldOut ? "opacity-85" : ""}`}>
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
                        onClick={() => { setDetail({ shopId: sid, item: it }); setGIndex(0); }}
                        className="relative w-24 h-24 overflow-hidden rounded-xl bg-zinc-100 flex items-center justify-center shrink-0 border cursor-pointer group focus:outline-none focus:ring-2 focus:ring-zinc-900/50"
                        title="画像を開く"
                        aria-disabled={isSoldOut}
                    >
                        {it.main_image_path ? (
                            <BgImage
                                path={it.main_image_path}
                                alt={it.name}
                                className="absolute inset-0 pointer-events-none transition-transform group-hover:scale-[1.02] w-full h-full rounded-xl"
                                eager={false}  // 一覧はスクロール表示なので遅延でOK
                            />
                        ) : (
                            <span className="text-4xl pointer-events-none">{it.photo ?? "🛍️"}</span>
                        )}

                        {/* 売り切れオーバーレイ */}
                        {isSoldOut && (
                            <div className="absolute inset-0 bg-black/45 pointer-events-none rounded-xl" aria-hidden="true" />
                        )}

                        {/* 売り切れリボン */}
                        {isSoldOut && (
                            <div className="absolute -left-3 top-2 rotate-[-18deg] pointer-events-none" aria-hidden="true">
                                <span className="inline-block bg-red-600 text-white text-[11px] px-3 py-1 rounded">
                                    Sold out
                                </span>
                            </div>
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
                        // ★ 追加: 右上の🗑️分だけ右パディングを空ける（7=28px分の少し余裕を見て pr-10）
                        className={`flex-1 min-w-0 text-left ${onRemove ? "pr-10" : ""}`}
                    >
                        <div className="w-full text-md font-bold pt-1 leading-tight break-words line-clamp-2 min-h-[2.5rem]">
                            {it.name}
                        </div>
                        {/* 以下既存そのまま */}
                        {isSoldOut ? (
                            <div className="mt-0.5 text-[11px] text-zinc-500">
                                ありがとうございました！またのご利用をお待ちしています。
                            </div>
                        ) : (
                            <div className="mt-2 text-xs text-zinc-500 flex items-center gap-1 w-full">
                                <span>⏰</span>
                                <span className="truncate">受取 {it.pickup}</span>
                            </div>
                        )}
                        <div className="mt-2 text-base font-semibold">{currency(it.price)}</div>
                    </button>

                </div>

                {/* 右下：数量チップ（元から remain<=0 ならボタンはdisabledになる） */}
                <div className="absolute bottom-0 right-1 rounded-full px-2 py-1" onClick={(e) => e.stopPropagation()}>
                    <QtyChip sid={sid} it={it} />
                </div>
                {/* ★ 追加：右上に「削除」ボタン（onRemove が渡された場合のみ表示） */}
                {onRemove && (
                    <button
                        type="button"
                        aria-label="この商品をカートから削除"
                        title="この商品をカートから削除"
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        className="absolute top-2 right-1 inline-flex items-center justify-center w-7 h-7 rounded-full border bg-white hover:bg-zinc-50 text-[13px]"
                    >
                        🗑️
                    </button>
                )}
            </div>
        );
    };



    // 店舗カード詳細メタ開閉
    const [metaOpen, setMetaOpen] = useState<Record<string, boolean>>({});


    // ホーム以外で表示する「戻る」ボタン用の簡易履歴
    const [tabHistory, setTabHistory] = useState<Array<'home' | 'cart' | 'order' | 'account'>>(['home']);
    useEffect(() => {
        try { setTabHistory(h => (h[h.length - 1] === (tab as any) ? h : [...h, tab as any])); } catch {/* noop */ }
    }, [tab]);
    const goBack = useCallback(() => {
        setTabHistory(h => {
            const next = h.slice(0, Math.max(1, h.length - 1));
            const prev = next[next.length - 1] ?? 'home';
            try { if (prev === 'order') setOrderTarget(undefined); } catch {/* noop */ }
            try { setTab(prev as any); } catch {/* noop */ }
            return next;
        });
    }, [setTab, setOrderTarget]);

    if (!hydrated) return null;

    return (
        <MinimalErrorBoundary>
            <div className="min-h-screen bg-[#f6f1e9]">{/* 柔らかいベージュ背景 */}
                <header className="sticky top-0 z-20 bg-white/85 backdrop-blur border-b">
                    <div className="max-w-[448px] mx-auto px-4 py-3 flex items-center justify-between" suppressHydrationWarning>
                        {/* ← 左：戻るボタン（home以外で表示） */}
                        <div className="min-w-[40px]">
                            {tab !== 'home' ? (
                                <button
                                    type="button"
                                    onClick={goBack}
                                    aria-label="戻る"
                                    className="inline-flex items-center justify-center w-9 h-9 rounded-full border bg-white hover:bg-zinc-50"
                                    title="戻る"
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
                                        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <polyline points="15 18 9 12 15 6"></polyline>
                                    </svg>
                                    <span className="sr-only">戻る</span>
                                </button>
                            ) : (
                                /* ※ home のときは幅合わせのダミー */
                                <span className="inline-block w-9 h-9" aria-hidden="true" />
                            )}
                        </div>

                        {/* 中央のタイトルは削除（空にしてセンタリング維持したいなら空スパンでもOK） */}
                        <span className="sr-only">ヘッダー</span>

                        {/* → 右：時計＆カートは現状のまま */}
                        <div className="flex items-center gap-3">
                            <div className="text-xs text-zinc-500">{clock || "—"}</div>
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
                            <div className="flex items-center justify-between">
                                {/* <h2 className="text-base font-semibold">近くのお店</h2> */}

                                {/* 並び替えトグル */}
                                <div role="group" aria-label="並び替え" className="inline-flex rounded-xl border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setSortMode('distance')}
                                        aria-pressed={sortMode === 'distance'}
                                        className={`px-3 py-1.5 text-sm ${sortMode === 'distance' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700'}`}
                                        title="距離の近い順"
                                    >
                                        距離順
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSortMode('price')}
                                        aria-pressed={sortMode === 'price'}
                                        className={`px-3 py-1.5 text-sm border-l ${sortMode === 'price' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700'}`}
                                        title="価格の安い順（最安値）"
                                    >
                                        価格順
                                    </button>
                                </div>
                            </div>


                            {/* 現在地取得と表示 */}
                            {/* <div className="rounded-xl border bg-white p-3">
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={requestLocation}
                                        className="px-3 py-1.5 rounded border cursor-pointer"
                                        aria-busy={locState === 'getting'}
                                        aria-live="polite"
                                    >
                                        {locState === 'getting' ? '現在地を取得中…' : '現在地を取得'}
                                    </button>
                                    {myPos && (
                                        <div className="text-sm text-zinc-700">
                                            現在地: 緯度 {myPos.lat.toFixed(5)}, 経度 {myPos.lng.toFixed(5)}
                                        </div>
                                    )}
                                    {!myPos && locState === 'error' && (
                                        <div className="text-sm text-red-600">{locError ?? '位置情報の取得に失敗しました'}</div>
                                    )}

                                </div>

                                {myPos && (
                                    <div className="mt-2 rounded-lg overflow-hidden border">
                                        <iframe
                                            title="現在地の地図"
                                            src={`https://www.google.com/maps?q=${encodeURIComponent(myPos.lat + ',' + myPos.lng)}&hl=ja&z=16&output=embed`}
                                            width="100%"
                                            height="160"
                                            style={{ border: 0 }}
                                            loading="lazy"
                                            referrerPolicy="no-referrer-when-downgrade"
                                            aria-label="Googleマップで現在地を表示"
                                        />
                                    </div>
                                )}
                            </div> */}



                            <div className="grid grid-cols-1 gap-3">
                                {shopsSorted.map((s, idx) => {
                                    // ★ デバッグ：埋め込み src → 座標 抽出値 と MAP リンク最終URLを確認
                                    if (process.env.NEXT_PUBLIC_DEBUG === '1') {
                                        console.log('[MAP debug]', s.name, extractLatLngFromGoogleEmbedSrc(s.gmap_embed_src ?? undefined), '→ link:', googleMapsUrlForShop(s));
                                    }

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

                                    // Product 型に publish_at?: string | null を追加したうえで…

                                    const visibleItems = s.items.filter(it => {
                                        const r = getReserved(s.id, it.id);
                                        const remain = Math.max(0, it.stock - r);
                                        const expired = isPickupExpired(it.pickup);
                                        // ★ 公開前（publish_at が未来）は一覧に出さない
                                        const notYet = it.publish_at ? (Date.parse(it.publish_at) > Date.now()) : false;
                                        return !expired && !notYet && it.stock >= 0;
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
                                                                ? publicImageUrl(s.cover_image_path)!
                                                                : idx % 3 === 0
                                                                    ? "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?q=80&w=1200&auto=format&fit=crop"
                                                                    : idx % 3 === 1
                                                                        ? "https://images.unsplash.com/photo-1475855581690-80accde3ae2b?q=80&w=1200&auto=format&fit=crop"
                                                                        : "https://images.unsplash.com/photo-1460306855393-0410f61241c7?q=80&w=1200&auto=format&fit=crop"
                                                        }
                                                        alt={s.name}
                                                        className="w-full h-44 object-cover rounded-2xl"
                                                        loading="lazy"
                                                        decoding="async"
                                                        width={1200}
                                                        height={176}  /* h-44 ≒ 44 * 4 = 176px */
                                                    />
                                                    <div className="absolute left-3 top-3 px-2 py-1 rounded bg-black/60 text-white text-sm">
                                                        {s.name}
                                                    </div>
                                                    {(() => {
                                                        const tt = travelTimeLabelFor(s);
                                                        return (
                                                            <span
                                                                className="absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-[11px]"
                                                                aria-label={`所要時間: ${tt.text}`}
                                                            >
                                                                {/* 絵文字アイコンを正方形ボックスで中央寄せ */}
                                                                <span className="inline-grid w-4 h-4 mr-1 place-items-center leading-none text-[16px]">
                                                                    {tt.icon}
                                                                </span>
                                                                {/* テキストも行高を1にして上下を詰める */}
                                                                <span className="font-medium leading-[1]">{tt.text}</span>
                                                            </span>
                                                        );
                                                    })()}
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
                                                        className="
     inline-flex items-center justify-center
     px-3 py-2 rounded-xl border
     bg-[var(--cart-btn-bg)] text-[var(--cart-btn-fg)] border-[var(--cart-btn-border)]
     
     disabled:opacity-40 disabled:cursor-not-allowed
     transition-colors
   "
                                                        onClick={() => {
                                                            setTab("cart");
                                                            // カート描画後にこの店舗の先頭セクションへスクロール
                                                            setPendingScrollShopId(s.id);
                                                        }}
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

                                                            {/* ★ 追加：TEL */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>📞</span>
                                                                {s.tel ? (
                                                                    <a href={`tel:${s.tel.replace(/\s+/g, '')}`} className="font-medium underline decoration-1 underline-offset-2">
                                                                        {s.tel}
                                                                    </a>
                                                                ) : (
                                                                    <span className="font-medium">—</span>
                                                                )}
                                                            </span>

                                                            {/* ★ 追加：URL */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>🔗</span>
                                                                {s.url ? (
                                                                    <a
                                                                        href={s.url}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        className="font-medium underline decoration-1 underline-offset-2"
                                                                        title={s.url}
                                                                    >
                                                                        {(() => {
                                                                            try {
                                                                                const u = new URL(s.url);
                                                                                return u.host.replace(/^www\./, '');
                                                                            } catch {
                                                                                return s.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
                                                                            }
                                                                        })()}
                                                                    </a>
                                                                ) : (
                                                                    <span className="font-medium">—</span>
                                                                )}
                                                            </span>

                                                            {/* 距離 */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>📍</span>
                                                                <span className="font-medium">{distanceLabelFor(s)}</span>
                                                            </span>

                                                            {/* カテゴリ */}
                                                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                                                                <span>🏷️</span>
                                                                <span className="font-medium">{m.category ?? "—"}</span>
                                                            </span>
                                                        </div>

                                                        {/* 住所/ミニマップ（スクショ風） */}
                                                        <div className="mt-3">
                                                            <div className="flex items-center gap-2 text-sm text-zinc-700">
                                                                <span>🏢</span>
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
                                                                    {/* 住所/ミニマップ（埋め込み） */}
                                                                    <div className="relative mt-2 rounded-xl overflow-hidden border
                touch-pan-y touch-pinch-zoom overscroll-contain">
                                                                        <iframe
                                                                            key={s.id}
                                                                            className="w-full h-60 md:h-80" // ← 高さを少し増やすと +- UI が確実に見えます
                                                                            src={buildMapEmbedSrc({
                                                                                name: s.name,
                                                                                address: s.address,
                                                                                place_id: s.place_id ?? null,
                                                                                gmap_embed_src: s.gmap_embed_src ?? null,
                                                                                gmap_url: s.gmap_url ?? null,
                                                                                lat: s.lat,
                                                                                lng: s.lng,
                                                                                zoomOnPin: s.zoomOnPin,
                                                                            })}
                                                                            loading="lazy"
                                                                            referrerPolicy="no-referrer-when-downgrade"
                                                                            allowFullScreen
                                                                            title={`${s.name} の地図`}
                                                                            // 念のため（親のどこかで pointer-events: none が掛かっていた場合の保険）
                                                                            style={{ pointerEvents: 'auto' }}
                                                                        />
                                                                    </div>

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
                            {Object.keys(cartGroups).length === 0 && <p className="text-sm text-zinc-500">カートは空です</p>}
                            {(() => {
                                const seen = new Set<string>(); // 店舗ごとの「最初の一個」を判定
                                return Object.keys(cartGroups).map(gkey => {
                                    const g = cartGroups[gkey];
                                    const sid = g.storeId;
                                    const storeName = shopsById.get(sid)?.name || sid;
                                    const groupQty = qtyByGroup[gkey] || 0;
                                    const isFirstOfStore = !seen.has(sid);
                                    if (isFirstOfStore) seen.add(sid);

                                    return (
                                        <div
                                            key={gkey}
                                            ref={el => { if (isFirstOfStore) cartStoreAnchorRefs.current[sid] = el; }}
                                            className="rounded-2xl border bg-white"
                                        >

                                            <div className="p-4 border-b flex items-center justify-between">
                                                <div className="text-sm font-semibold">
                                                    {storeName}
                                                    {/* 同一店舗で複数セクションが並ぶ可能性があるが、UIは既存のまま */}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (g.lines.length === 0) {
                                                            emitToast("info", "このカートは空です");
                                                            return;
                                                        }
                                                        if (confirm("このグループのカートを空にしますか？")) {
                                                            // このグループに含まれる行だけを削除
                                                            const ids = new Set(g.lines.map(l => `${l.shopId}:${l.item.id}`));
                                                            setCart(cs => cs.filter(l => !ids.has(`${l.shopId}:${l.item.id}`)));
                                                            emitToast("success", "カートを空にしました");
                                                        }
                                                    }}
                                                    disabled={g.lines.length === 0}
                                                    className="text-[11px] px-2 py-1 rounded border cursor-pointer disabled:opacity-40"
                                                    aria-disabled={g.lines.length === 0}
                                                    title="このグループのカートを空にする"
                                                >
                                                    カートを空にする
                                                </button>
                                            </div>

                                            <div className="p-4 divide-y divide-zinc-200">
                                                {(g.lines ?? [])
                                                    .filter(l => l && l.item && typeof l.qty === "number")
                                                    .map((l, i) => {
                                                        const rmKey = `${sid}:${l.item.id}`;
                                                        return (
                                                            <ProductLine
                                                                key={`${l.item?.id ?? "unknown"}-${i}`}
                                                                sid={sid}
                                                                it={l.item}
                                                                noChrome
                                                                onRemove={() => {
                                                                    setCart(cs => cs.filter(x => `${x.shopId}:${x.item.id}` !== rmKey));
                                                                    emitToast("success", "商品をカートから削除しました");
                                                                }}
                                                            />
                                                        );
                                                    })}
                                            </div>


                                            {/* 受け取り予定時間（必須）: グループキーで保持 */}
                                            <div className="px-4">
                                                <div className="border-t mt-2 pt-3">
                                                    {(() => {
                                                        // 既存ウィンドウを取得（グループ内商品の共通交差）
                                                        const baseWin = cartGroups[gkey]?.window ?? null;

                                                        // 「今 + LEAD_CUTOFF_MIN（20分）」を計算
                                                        const nowMin = nowMinutesJST();
                                                        const minStart = nowMin + LEAD_CUTOFF_MIN;

                                                        // ★ 追加：10分単位に切り上げる関数（分→分）
                                                        const ceilTo10 = (m: number) => Math.ceil(m / 10) * 10;

                                                        // baseWin があるときだけ start を切り上げる
                                                        let adjustedWin: { start: number; end: number } | null = null;
                                                        if (baseWin) {
                                                            // 元の開始とリードタイムを比較し、さらに「10分単位」に切り上げ
                                                            const rawStart = Math.max(baseWin.start, minStart);
                                                            const start = ceilTo10(rawStart);       // ← ここで 00/10/20… 始まりを保証
                                                            const end = baseWin.end;
                                                            adjustedWin = (start < end) ? { start, end } : null;
                                                        }
                                                        // 枠が全滅したかどうか（baseWin があるケースのみ判定する）
                                                        const noSlot = (baseWin != null) && (adjustedWin == null);

                                                        return (
                                                            <>
                                                                <PickupTimeSelector
                                                                    storeId={sid}
                                                                    value={pickupByGroup[gkey] ?? null}
                                                                    onSelect={(slot) => {
                                                                        // 保険：外部入力や直打ち対策で 20分前チェックは継続
                                                                        const startMinSel = Number(slot.start.slice(0, 2)) * 60 + Number(slot.start.slice(3, 5));
                                                                        const nowMinSel = nowMinutesJST();
                                                                        if (startMinSel < nowMinSel + LEAD_CUTOFF_MIN) {
                                                                            emitToast("error", `直近枠は選べません（受け取り${LEAD_CUTOFF_MIN}分前まで）`);
                                                                            return;
                                                                        }
                                                                        setPickupByGroup(prev => ({ ...prev, [gkey]: slot }));
                                                                    }}
                                                                    // ★ ポイント：10分切り上げ済みの開始時刻を渡す
                                                                    limitWindow={adjustedWin ?? undefined}
                                                                    stepOverride={(() => {
                                                                        const info = (presetMap as Record<string, StorePresetInfo | undefined>)[sid];
                                                                        const cur = (info?.current ?? 1) as number;
                                                                        return info?.slots?.[cur]?.step ?? 10;
                                                                    })()}
                                                                />
                                                                {noSlot && (
                                                                    <p className="mt-2 text-xs text-zinc-500">
                                                                        直近枠は選択不可のため、現在は選べる時間帯がありません。時間をおいてお試しください。
                                                                    </p>
                                                                )}
                                                            </>
                                                        );
                                                    })()}

                                                    {!pickupByGroup[gkey] && (
                                                        <p className="mt-2 text-xs text-red-500">受け取り予定時間を選択してください。</p>
                                                    )}
                                                </div>
                                            </div>


                                            <div className="px-4 pt-3">
                                                <div className="flex items-center justify-between text-sm">
                                                    <span className="font-medium">合計金額</span>
                                                    <span className="tabular-nums font-bold text-lg">{currency(groupTotal(gkey))}</span>
                                                </div>
                                            </div>

                                            <div className="p-4 border-t mt-2">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const sel = pickupByGroup[gkey];
                                                        if (!sel) return;
                                                        const startMin = Number(sel.start.slice(0, 2)) * 60 + Number(sel.start.slice(3, 5));
                                                        const nowMin = nowMinutesJST();
                                                        if (startMin < nowMin + LEAD_CUTOFF_MIN) {
                                                            alert(`受け取り開始まで${Math.max(0, startMin - nowMin)}分です。直近枠は選べません（${LEAD_CUTOFF_MIN}分前まで）。`);
                                                            return;
                                                        }
                                                        // ★ 注文ターゲットは "グループキー"
                                                        startStripeCheckout(gkey);
                                                    }}
                                                    disabled={!pickupByGroup[gkey]}
                                                    className={`w-full px-3 py-2 rounded text-white cursor-pointer
            ${!pickupByGroup[gkey] ? "bg-zinc-300 cursor-not-allowed" : "bg-zinc-900 hover:bg-zinc-800"}`}
                                                    aria-disabled={!pickupByGroup[gkey]}
                                                >
                                                    注文画面へ
                                                </button>
                                            </div>
                                        </div>
                                    );
                                });
                            })()}

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

                                                                <div className="text-xs text-zinc-500 mb-1">引換コード</div>
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

                    {tab === "order" && orderTarget && (
                        <section className="mt-4 space-y-4">
                            <h2 className="text-base font-semibold">注文の最終確認</h2>
                            {(() => {
                                const g = cartGroups[orderTarget];           // ★ グループを取得
                                if (!g) return <div className="text-sm text-red-600">対象カートが見つかりません</div>;
                                const sid = g.storeId;
                                const storeName = shopsById.get(sid)?.name || sid;
                                const total = groupTotal(orderTarget);

                                return (
                                    <div className="rounded-2xl border bg-white">
                                        <div className="p-4 border-b flex items-center justify-between">
                                            <div className="text-sm font-semibold">{storeName}</div>
                                            <div className="text-sm font-semibold">{currency(total)}</div>
                                        </div>

                                        {/* カートで選んだ受取時間の表示（グループ基準） */}
                                        {(() => {
                                            const sel = pickupByGroup[orderTarget] ?? null;
                                            return (
                                                <div className="p-4 bg-zinc-50 border-t">
                                                    <div className="text-xs text-zinc-500">受取予定時間</div>
                                                    <div className="mt-1 text-sm font-medium">
                                                        {sel ? `${sel.start}〜${sel.end}` : "未選択"}
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        <div className="p-4 border-t space-y-3">
                                            {/* 行：支払い方法（スクショ風） */}
                                            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                                                <div className="text-sm font-medium">クレジット</div>
                                                <div className="text-sm text-zinc-500 truncate">
                                                    {selectedPayLabel ? selectedPayLabel : "選択されていません"}
                                                </div>
                                                <button
                                                    type="button"
                                                    className="text-[#6b0f0f] text-sm underline decoration-1 underline-offset-2"
                                                    onClick={() => setIsPayMethodOpen(true)}
                                                >
                                                    {selectedPayLabel ? "変更する" : "選択する"}
                                                </button>
                                            </div>

                                            <p className="text-xs text-zinc-500">
                                                テスト: 4242 4242 4242 4242 は成功 / 4000 0000 0000 0002 は失敗として扱います。
                                            </p>

                                            {/* 支払ボタン：カード選択が済むまで無効 */}
                                            <button
                                                type="button"
                                                onClick={() => startStripeCheckout()}
                                                disabled={
                                                    isPaying ||
                                                    !selectedPayLabel ||
                                                    ((cartGroups[orderTarget]?.lines.length ?? 0) === 0)
                                                }
                                                className={`w-full px-3 py-2 rounded border text-white
      ${(!selectedPayLabel || isPaying) ? "bg-zinc-300 cursor-not-allowed" : "bg-zinc-900 hover:bg-zinc-800"}`}
                                            >
                                                Stripe で支払う（デモ）
                                            </button>
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
                                                onClick={() => startStripeCheckout()}
                                                disabled={isPaying || ((cartGroups[orderTarget]?.lines.length ?? 0) === 0)}
                                                className="w-full px-3 py-2 rounded border cursor-pointer disabled:opacity-40 bg-zinc-900 text-white"
                                            >
                                                Stripe で支払う（デモ）
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}
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

                {/* ▼▼ Stripe 決済用ボトムシート：client_secret が取れたら表示 ▼▼ */}
                <BottomSheet
                    open={isCheckoutOpen && !!checkoutClientSecret}
                    title="お支払い（Stripe）"
                    onClose={() => { setIsCheckoutOpen(false); setCheckoutClientSecret(null); }}
                >
                    {checkoutClientSecret && (
                        <EmbeddedCheckoutProvider
                            stripe={stripePromise}
                            options={{ clientSecret: checkoutClientSecret }}
                        >
                            {/* EmbeddedCheckout 自体が注文詳細＋決済UIをすべて描画します */}
                            <div className="px-0">
                                <EmbeddedCheckout />
                            </div>
                        </EmbeddedCheckoutProvider>
                    )}
                </BottomSheet>

                {/* ▲▲ ここまで ▲▲ */}


                {/* 商品詳細モーダル */}
                {detail && (
                    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[2000]">
                        <div
                            className="absolute inset-0 bg-black/40 z-[2000]"
                            onClick={() => setDetail(null)}
                        />
                        <div className="absolute inset-0 flex items-center justify-center p-4 z-[2001]">
                            <div className="max-w-[520px] w-full bg-white rounded-2xl shadow-xl max-h-[85vh] flex flex-col overflow-hidden">
                                <div
                                    className="relative" ref={carouselWrapRef}
                                >
                                    {/* メイン画像（3枚ギャラリー） */}
                                    {detailImages.length > 0 ? (
                                        <div className="relative overflow-hidden rounded-t-2xl bg-black aspect-[16/9]">
                                            <div
                                                className="absolute inset-0 h-full"
                                                style={{
                                                    display: 'flex',
                                                    width: `${(imgCount + 2) * 100}%`, // クローン込みの幅
                                                    height: '100%',
                                                    transform: `translateX(-${pos * (100 / (imgCount + 2))}%)`,
                                                    transition: anim ? 'transform 320ms ease' : 'none',
                                                    willChange: 'transform',
                                                    backfaceVisibility: 'hidden',
                                                }}
                                                onTransitionEnd={() => {
                                                    // 1) どのケースでもアニメ終了後は必ず解除
                                                    setAnim(false);

                                                    // 2) クローン端にいたら本物へ瞬間ジャンプ（transition なし）
                                                    setPos((p) => {
                                                        if (p === 0) return imgCount;        // 左端クローン → 末尾の実画像へ
                                                        if (p === imgCount + 1) return 1;    // 右端クローン → 先頭の実画像へ
                                                        return p;                            // 中間ならそのまま
                                                    });

                                                    // 3) 表示中インデックスを確定
                                                    setGIndex(targetIndexRef.current);
                                                }}
                                            >
                                                {loopImages.map((path, i) => (
                                                    <div key={`slide-${i}-${path}`} style={{ width: `${100 / (imgCount + 2)}%`, height: '100%', flex: `0 0 ${100 / (imgCount + 2)}%` }}>
                                                        <img
                                                            src={publicImageUrl(path)!}
                                                            alt={i === pos ? `${detail.item.name} 画像 ${gIndex + 1}/${imgCount}` : ''}
                                                            className="w-full h-full object-cover select-none"
                                                            draggable={false}
                                                            loading={i === pos ? 'eager' : 'lazy'}
                                                            decoding="async"
                                                            width={1280}
                                                            height={720}  /* aspect-[16/9] の枠に合わせた目安 */
                                                        />
                                                    </div>
                                                ))}
                                            </div>

                                            {/* 枚数バッジ n/n */}
                                            <div className="absolute right-2 bottom-2 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs">
                                                {imgCount > 0 ? (gIndex + 1) : 0}/{imgCount}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="w-full h-56 bg-zinc-100 flex items-center justify-center text-6xl rounded-t-2xl">
                                            <span>{detail.item.photo}</span>
                                        </div>
                                    )}


                                    {/* 左右ナビ（2枚以上） */}
                                    {imgCount > 1 && (
                                        <>
                                            <button
                                                type="button"
                                                className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-2 rounded-full bg-white/90 border shadow hover:bg-white"
                                                onClick={goPrev}
                                                aria-label="前の画像"
                                            >‹</button>
                                            <button
                                                type="button"
                                                className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-2 rounded-full bg-white/90 border shadow hover:bg-white"
                                                onClick={goNext}
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

                                <div className="p-4 space-y-3 overflow-auto">


                                    <div className="text-lg font-semibold leading-tight break-words">{detail.item.name}</div>
                                    <div className="text-sm text-zinc-600 flex items-center gap-3">
                                        <span className="inline-flex items-center gap-1"><span>⏰</span><span>受取 {detail.item.pickup}</span></span>
                                        <span className="inline-flex items-center gap-1"><span>🏷️</span><span className="tabular-nums">{currency(detail.item.price)}</span></span>
                                        <span className="ml-auto">
                                            <RemainChip remain={Math.max(0, detail.item.stock - getReserved(detail.shopId, detail.item.id))} />
                                        </span>
                                    </div>
                                    <div className="text-sm text-zinc-700 bg-zinc-50 rounded-xl p-3">
                                        {detail?.item?.note && detail.item.note.trim().length > 0
                                            ? detail.item.note
                                            : 'お店のおすすめ商品です。数量限定のため、お早めにお求めください。'}
                                    </div>

                                    <div className="pt-1">
                                        <button
                                            type="button"
                                            onClick={() => setAllergyOpen(true)}
                                            className="inline-flex items-center gap-1 text-[13px] text-[#6b0f0f] underline decoration-1 underline-offset-2"
                                        >
                                            <span
                                                aria-hidden
                                                className="inline-grid place-items-center w-4 h-4 rounded-full bg-[#6b0f0f] text-white text-[10px]"
                                            >i</span>
                                            <span>アレルギー・原材料について</span>
                                        </button>
                                    </div>
                                    <div className="flex items-center justify-between pt-2">
                                        <div className="text-base font-semibold">{currency(detail.item.price)}</div>
                                        <div className="rounded-full  px-2 py-1">
                                            <QtyChip sid={detail.shopId} it={detail.item} />
                                        </div>
                                    </div>
                                    {/* モーダルのフッター：閉じるのみ（「カートに追加」は削除） */}
                                    <div className="pt-1">
                                        <button
                                            type="button"
                                            className="w-full px-3 py-2 rounded-xl border"
                                            onClick={() => { setAllergyOpen(false); setDetail(null); }}
                                        >
                                            閉じる
                                        </button>
                                    </div>
                                </div>

                            </div>
                        </div>
                        {allergyOpen && (
                            <div className="absolute inset-0 z-[2002] pointer-events-none">
                                <div className="absolute inset-0 bg-black/30 pointer-events-auto" onClick={() => setAllergyOpen(false)} />
                                <div className="absolute left-1/2 -translate-x-1/2 bottom-4 w-full max-w-[520px] px-4 pointer-events-auto">
                                    <div className="mx-auto rounded-2xl bg-white border shadow-2xl overflow-hidden">
                                        <div className="py-2 grid place-items-center"><div aria-hidden className="h-1.5 w-12 rounded-full bg-zinc-300" /></div>
                                        <div className="px-4 pb-4">
                                            <div className="flex items-center justify-center mb-2">
                                                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-700 text-white text-sm" aria-hidden>i</span>
                                            </div>
                                            <h3 className="text-lg font-semibold text-center mb-2">アレルギー・原材料について</h3>
                                            <div className="text-sm text-zinc-700 space-y-2">
                                                <p>当アプリの商品は食品ロス削減を目的とした性質上、多くの場合、受け取りまで中身がわからない「福袋形式」での販売となります。そのため、個別商品のアレルゲンに関する詳細なご案内が難しいケースがあります。</p>
                                                <p>ご不安がある場合は、恐れ入りますが<strong>お店へ直接お問い合わせ</strong>ください。可能な範囲でご案内いたします。</p>
                                                <p className="text-zinc-500">なお、アレルギー等を理由とした商品の指定や入れ替えはお受けできない場合があります。</p>
                                            </div>
                                            <div className="mt-3 text-right">
                                                <button type="button" className="px-3 py-2 rounded-xl border bg-white hover:bg-zinc-50 text-sm" onClick={() => setAllergyOpen(false)}>閉じる</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div >

            {/* シート①：支払い方法の選択 */}
            {
                isPayMethodOpen && (
                    <BottomSheet
                        open
                        title="支払い方法を選択"
                        onClose={() => setIsPayMethodOpen(false)}
                    >
                        <div className="px-4 pb-4 space-y-2">
                            <button
                                type="button"
                                className="w-full text-left px-3 py-3 rounded-xl border hover:bg-zinc-50"
                                onClick={() => {
                                    setPaymentMethod('card');
                                    setIsPayMethodOpen(false);
                                    setIsCardEntryOpen(true); // 次：カード入力へ
                                }}
                            >
                                <div className="font-medium">クレジットカード</div>
                                <div className="text-xs text-zinc-500">Visa / Mastercard（テスト番号可）</div>
                            </button>
                        </div>
                    </BottomSheet>
                )
            }

            {/* シート②：カード番号入力（テスト） */}
            {
                isCardEntryOpen && (
                    <BottomSheet
                        open
                        title="カード情報の入力（テスト）"
                        onClose={() => setIsCardEntryOpen(false)}
                    >
                        <div className="px-4 pb-4 space-y-3">
                            {/* ① まずは使用するカードを選択（スクショの黄色枠イメージ） */}
                            <div className="space-y-2">
                                <div className="text-xs text-zinc-500">お支払いに使うカードを選択してください。</div>
                                {savedCards.map((c) => (
                                    <div key={c.id} className="flex items-center justify-between rounded-xl border p-3 bg-white">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium truncate">{c.brand} •••• {c.last4}</div>
                                            <div className="text-[11px] text-zinc-500">保存済みカード</div>
                                        </div>
                                        <button
                                            type="button"
                                            className="px-3 py-1.5 rounded-lg border bg-zinc-900 text-white hover:bg-zinc-800"
                                            onClick={() => {
                                                setSelectedPayLabel(`${c.brand}(${c.last4})`);
                                                setPaymentMethod('card');
                                                setIsCardEntryOpen(false);       // このシートを閉じる
                                                setIsPayMethodOpen(false);       // 前段の選択シートも閉じる
                                                emitToast("success", "カードを選択しました");
                                            }}
                                        >
                                            選択する
                                        </button>
                                    </div>
                                ))}

                                <button
                                    type="button"
                                    className="w-full text-center text-sm underline decoration-1 underline-offset-2 text-[#6b0f0f]"
                                    onClick={() => setShowCardFullForm(v => !v)}
                                >
                                    {showCardFullForm ? "保存済みカードの一覧に戻る" : "別のカードを使う"}
                                </button>
                            </div>

                            {/* ② 「別のカードを使う」を押したときだけ、従来の（テスト用）入力フォームを表示 */}
                            {showCardFullForm && (
                                <div className="space-y-2">
                                    <div className="text-xs text-zinc-500">テスト番号：4242 4242 4242 4242 は成功 / 4000 0000 0000 0002 は失敗</div>

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
                                                    onChange={(e) => {
                                                        const nd = e.target.value.replace(/\D/g, "").slice(0, 16);
                                                        setCardDigits(nd);
                                                        updateCardLabel(nd); // ← 既存のブランド表示更新（Visa(4242) など）
                                                    }}
                                                    inputMode="numeric"
                                                    maxLength={19}
                                                    autoComplete="cc-number"
                                                    aria-label="カード番号（テスト）"
                                                />
                                                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                                                    <span>{len}/16 桁</span>
                                                    <span>4桁ごとにスペース</span>
                                                </div>
                                                <div className="h-1 bg-zinc-200 rounded">
                                                    <div className="h-1 bg-zinc-900 rounded" style={{ width: `${(len / 16) * 100}%` }} />
                                                </div>

                                                <div className="grid grid-cols-2 gap-2 pt-1">
                                                    <button
                                                        type="button"
                                                        className="px-3 py-2 rounded-xl border"
                                                        onClick={() => setIsCardEntryOpen(false)}
                                                    >
                                                        閉じる
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="px-3 py-2 rounded-xl border bg-zinc-900 text-white hover:bg-zinc-800"
                                                        onClick={() => {
                                                            // 入力値からラベルを更新して採用（4242なら Visa(4242) など）
                                                            const d4 = (cardDigits.match(/\d{4}$/)?.[0]) ?? "";
                                                            if (d4) setSelectedPayLabel(`${payBrand.replace(/TEST/, 'クレジットカード')}(${d4})`);
                                                            setPaymentMethod('card');
                                                            setIsCardEntryOpen(false);
                                                            setIsPayMethodOpen(false);
                                                            emitToast("success", "カードを選択しました");
                                                        }}
                                                        disabled={cardDigits.replace(/\D/g, "").length < 12}
                                                    >
                                                        このカードを使う
                                                    </button>
                                                </div>
                                            </>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>
                    </BottomSheet>
                )
            }


        </MinimalErrorBoundary >
    );
}

function PayWithElementButton({ onSuccess, onError }: { onSuccess: () => void; onError: (msg: string) => void }) {
    const stripe = useStripe();
    const elements = useElements();
    const [loading, setLoading] = useState(false);

    return (
        <button
            type="button"
            className={`w-full px-3 py-2 rounded-xl border text-white ${loading ? "bg-zinc-300" : "bg-zinc-900 hover:bg-zinc-800"}`}
            disabled={!stripe || !elements || loading}
            onClick={async () => {
                if (!stripe || !elements) return;
                try {
                    setLoading(true);
                    const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
                    if (error) throw new Error(error.message || "決済に失敗しました");
                    onSuccess();
                } catch (e: any) {
                    onError(e?.message || "決済に失敗しました");
                } finally {
                    setLoading(false);
                }
            }}
        >
            このカードで支払う
        </button>
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
                                                <div className="text-xs text-zinc-500">ステータス</div>
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




