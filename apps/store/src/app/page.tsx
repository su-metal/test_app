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
  // TODO(req v2): DB スキーマ生成型に統一（supabase gen types）
  pickup_start?: string | null;
  pickup_end?: string | null;
  pickup_label?: string | null;
  pickup_presets_snapshot?: any | null;
  // 二段階引換: リクエスト/確定時刻（optional）
  redeem_request_at?: string | null;
  redeemed_at?: string | null;
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
  pickupStart: string | null;
  pickupEnd: string | null;
  pickupLabel?: string | null;
  presetLabel?: string | null;
  redeemRequestedAt?: string | null;
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
  pickup_slot_no?: number | null;
  publish_at?: string | null;
  note?: string | null;
};

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  main_image_path: string | null;
  sub_image_path1: string | null;
  sub_image_path2: string | null;
  pickup_slot_no?: number | null;
  publish_at?: string | null;
  note?: string | null;
};

// ===== Util =====
type Slot = "main" | "sub1" | "sub2";
const slotJp = (s: Slot) => (s === "main" ? "メイン" : s === "sub1" ? "サブ1" : "サブ2");

const getStoreId = () => {
  const sid = (typeof window !== "undefined" && (window as any).__STORE_ID__) || "";
  if (sid) return String(sid);
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem('store:selected') : null;
    return (v && v.trim()) ? v.trim() : "";
  } catch { return ""; }
};

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
    pickupStart: (r as any).pickup_start ?? null,
    pickupEnd: (r as any).pickup_end ?? null,
    pickupLabel: (r as any).pickup_label ?? null,
    presetLabel: (() => { try { const s: any = (r as any).pickup_presets_snapshot ?? null; const st: any = s?.start_time ?? s?.start; const en: any = s?.end_time ?? s?.end; return (st && en) ? `${String(st).slice(0, 5)}〜${String(en).slice(0, 5)}` : null; } catch { return null; } })(),
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
    pickup_slot_no: (r as any).pickup_slot_no ?? null,
    publish_at: (r as any).publish_at ?? null,
    note: (r as any).note ?? null,
  };
}

// === 画像縮小ユーティリティ（最大長辺 max、JPEG品質 quality） =================
async function downscaleFile(
  file: File,
  { max = 1080, quality = 0.9 }: { max?: number; quality?: number } = {}
): Promise<File> {
  if (!/^image\//.test(file.type)) return file; // 画像以外はそのまま
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale >= 1) return file; // 既に十分小さい
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality
    )
  );
  const base = file.name.replace(/\.\w+$/, '');
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
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
      // 空文字の x-store-id を送らない
      const headers: Record<string, string> = {};
      if (String(sid || '').trim()) headers['x-store-id'] = String(sid);
      const sb = createClient(url, key, { global: { headers } });
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

  // 「プルダウンの現在値」をここで一元管理
  const [sel, setSel] = useState<string>("");

  // 初期化：サーバーの“現在選択中”を最優先で反映 → 次に localStorage → 最後に一覧の先頭
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 1) サーバー側の現在選択（優先）
        const insp = await fetch("/api/auth/session/inspect", { cache: "no-store" })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null);
        let sid: string =
          (insp?.store_id && String(insp.store_id).trim()) || "";

        // 2) ローカル復元（なければ last→selected の順）
        if (!sid) {
          try {
            const last = localStorage.getItem("store:last_store_id");
            const cur = localStorage.getItem("store:selected");
            sid = String(last || cur || "");
          } catch {
            /* noop */
          }
        }

        // 3) まだ空なら一覧の先頭（ロード済みのとき）
        if (!sid && stores.length > 0) {
          sid = String(stores[0].id);
        }

        if (!alive) return;
        setSel(sid || "");

        // ウィンドウ変数 / localStorage にも同期
        try {
          (window as any).__STORE_ID__ = sid || "";
          if (sid) {
            localStorage.setItem("store:selected", sid);
            localStorage.setItem("store:last_store_id", sid);
          }
        } catch {
          /* noop */
        }
      } catch {
        /* noop */
      }
    })();
    return () => {
      alive = false;
    };
  }, [stores.length]); // 一覧が来たら一度だけ評価

  // 変更時：サーバーへ POST → ローカル同期 → 画面を確実に更新
  const onChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setSel(v);

    try {
      await fetch("/api/auth/session/select-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ storeId: v, store_id: v }), // 互換保持
      });
    } catch {
      /* noop */
    }

    try {
      (window as any).__STORE_ID__ = v;
      localStorage.setItem("store:selected", v);
      localStorage.setItem("store:last_store_id", v);
    } catch {
      /* noop */
    }

    // 関連一覧（注文/商品など）を選択店舗で再評価させる
    location.reload();
  }, []);

  return (
    <label className="flex items-center gap-2 text-sm mr-2">
      <span className="text-zinc-600">店舗</span>
      <select
        value={sel}
        onChange={onChange}
        className="rounded-lg border px-2 py-1 bg-white"
      >
        {/* 一覧が未取得の間も“選択中の表示”は維持 */}
        {sel && !stores.find(s => String(s.id) === sel) && (
          <option value={sel}>{sel}</option>
        )}
        {stores.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {!sel && stores.length === 0 && (
          <option value="">店舗を読み込み中…</option>
        )}
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

// ===== Pickup Presets (name + time) =====
function usePickupPresets() {
  const supabase = useSupabase();
  const [presets, setPresets] = useState<Record<1 | 2 | 3, { name: string; start: string; end: string }>>({
    1: { name: "プリセット1", start: "00:00", end: "00:00" },
    2: { name: "プリセット2", start: "00:00", end: "00:00" },
    3: { name: "プリセット3", start: "00:00", end: "00:00" },
  });
  const [loading, setLoading] = useState(false);

  const hhmm = (t?: string | null) => (t ? t.slice(0, 5) : "00:00");

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const sidForPreset = getStoreId();
    if (!String(sidForPreset || '').trim()) { setLoading(false); return; }
    const { data, error } = await supabase
      .from("store_pickup_presets")
      .select("slot_no,name,start_time,end_time")
      .eq("store_id", sidForPreset)
      .order("slot_no", { ascending: true });

    if (!error && Array.isArray(data)) {
      const next = { ...presets };
      for (const row of data as Array<{ slot_no: 1 | 2 | 3; name: string; start_time: string; end_time: string }>) {
        next[row.slot_no] = {
          name: row.name?.trim() || `プリセット${row.slot_no}`,
          start: hhmm(row.start_time),
          end: hhmm(row.end_time),
        };
      }
      setPresets(next);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  return { presets, loading, reload: load } as const;
}


// ===== Products =====
function useProducts() {
  const supabase = useSupabase();
  const [products, setProducts] = useState<Product[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const chanName = `products-realtime-${getStoreId()}`;
  const prodChan = useBroadcast('product-sync');
  const [perr, setPerr] = useState<string | null>(null);
  const [ploading, setPloading] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return; setPloading(true); setPerr(null);
    const { data, error } = await supabase
      .from('products')
      .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note')
      .eq('store_id', getStoreId())
      .order('updated_at', { ascending: false });
    if (error) setPerr(error.message || '商品の取得に失敗しました');
    else setProducts(((data ?? []) as ProductsRow[]).map(mapProduct));
    setPloading(false);
  }, [supabase]);


  const cleanup = useCallback(() => {
    try { channelRef.current?.unsubscribe?.(); } catch { }
    try { const sbAny = supabase as any; if (sbAny && channelRef.current) sbAny.removeChannel(channelRef.current); } catch { }
    channelRef.current = null;
  }, [supabase]);


  useEffect(() => {
    (async () => {
      await load();               // まずは通常取得
      if (!supabase) return;
      // 既存チャンネルを外してから張り直す
      cleanup();

      const sid = getStoreId();
      if (!String(sid || '').trim()) return;
      const ch = (supabase as any)
        .channel(chanName)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'products', filter: `store_id=eq.${sid}` },
          (p: any) => { if (p?.new) setProducts(prev => [mapProduct(p.new as ProductsRow), ...prev]); }
        )
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'products', filter: `store_id=eq.${sid}` },
          (p: any) => {
            if (p?.new) {
              const row = mapProduct(p.new as ProductsRow);
              setProducts(prev => prev.map(it => it.id === row.id ? row : it));
            }
          }
        )
        // DELETE は REPLICA IDENTITY 設定によって store_id が old に無いことがあるため filter を外す
        .on('postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'products' },
          (p: any) => {
            const id = String((p?.old as any)?.id || '');
            if (!id) return;
            setProducts(prev => prev.filter(it => it.id !== id));
          }
        )
        .subscribe() as RealtimeChannel;

      channelRef.current = ch;
    })();

    return () => { cleanup(); };
  }, [supabase, load, cleanup, chanName]);


  const add = useCallback(
    async (payload: {
      name: string;
      price: number;
      stock: number;
      pickup_slot_no?: number | null;
      publish_at?: string | null;
      note?: string | null;
    }): Promise<Product | null> => {
      if (!payload.name) { setPerr('商品名を入力してください'); return null; }
      if (!supabase) return null;

      setPloading(true); setPerr(null);
      const { data, error } = await supabase
        .from('products')
        .insert({
          ...payload,
          store_id: getStoreId(),
          pickup_slot_no: payload.pickup_slot_no ?? null,
          note: payload.note ?? null,
        })
        .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note')
        .single();

      if (error) {
        setPerr(error.message || '商品の登録に失敗しました');
        setPloading(false);
        return null;
      }

      if (data) {
        const mapped = mapProduct(data as ProductsRow);
        setProducts(prev => [mapped, ...prev]);
        prodChan.post({ type: 'PRODUCT_ADDED', id: String((data as any).id), at: Date.now() });
        setPloading(false);
        return mapped; // ★ 作成した商品の情報を返す
      }

      setPloading(false);
      return null;
    },
    [supabase]
  );

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

  const updatePickupSlot = useCallback(async (id: string, slot: number | null) => {
    // 楽観更新
    setProducts(prev => prev.map(p => p.id === id ? { ...p, pickup_slot_no: slot } : p));
    if (!supabase) return;
    const { data, error } = await supabase
      .from('products')
      .update({ pickup_slot_no: slot })
      .eq('id', id)
      .eq('store_id', getStoreId())
      .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note')
      .single();
    if (error) {
      // 失敗時はリロードで整合
      await load();
    } else if (data) {
      setProducts(prev => prev.map(p => p.id === id ? mapProduct(data as ProductsRow) : p));
    }
  }, [supabase, load]);


  const updatePublishAt = useCallback(async (id: string, isoOrNull: string | null) => {
    // 楽観更新
    setProducts(prev => prev.map(p => p.id === id ? { ...p, publish_at: isoOrNull } : p));
    if (!supabase) return;
    const { data, error } = await supabase
      .from('products')
      .update({ publish_at: isoOrNull })
      .eq('id', id)
      .eq('store_id', getStoreId())
      .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at')
      .single();
    if (error) {
      await load(); // 差し戻し
    } else if (data) {
      setProducts(prev => prev.map(p => p.id === id ? mapProduct(data as ProductsRow) : p));
    }
  }, [supabase, load]);

  const updateNote = useCallback(async (id: string, nextRaw: string | null) => {
    // 300 文字・trim・空なら null
    const normalized = (nextRaw ?? "").trim().slice(0, 300) || null;

    // 楽観更新（まずローカル反映）
    setProducts(prev => prev.map(p => p.id === id ? { ...p, note: normalized } : p));

    if (!supabase) return;
    const { data, error } = await supabase
      .from('products')
      .update({ note: normalized })
      .eq('id', id)
      .eq('store_id', getStoreId())
      .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note')
      .single();

    if (error) {
      // 失敗時は再同期（ロールバック）
      await load();
      return;
    }
    if (data) {
      setProducts(prev => prev.map(p => p.id === id ? mapProduct(data as ProductsRow) : p));
    }
  }, [supabase, load]);

  // まとめて更新（名前・価格・在庫・受取プリセット・公開・ひとこと）
  const updateProduct = useCallback(async (id: string, patch: {
    name?: string;
    price?: number;
    stock?: number;
    pickup_slot_no?: number | null;
    publish_at?: string | null;
    note?: string | null;
  }) => {
    // 正規化（ビジネスルール）
    const normalized = {
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.price !== undefined ? { price: Math.max(0, Math.floor(Number(patch.price || 0))) } : {}),
      ...(patch.stock !== undefined ? { stock: Math.max(0, Math.floor(Number(patch.stock || 0))) } : {}),
      ...(patch.pickup_slot_no !== undefined ? { pickup_slot_no: (patch.pickup_slot_no ?? null) } : {}),
      ...(patch.publish_at !== undefined ? { publish_at: patch.publish_at ?? null } : {}),
      ...(patch.note !== undefined ? { note: (patch.note ?? '').trim().slice(0, 300) || null } : {}),
    };

    // 楽観更新
    setProducts(prev => prev.map(p => p.id === id ? { ...p, ...normalized } as Product : p));

    if (!supabase) return;
    const { data, error } = await supabase
      .from('products')
      .update(normalized)
      .eq('id', id)
      .eq('store_id', getStoreId())
      .select('id,store_id,name,price,stock,updated_at,main_image_path,sub_image_path1,sub_image_path2,pickup_slot_no,publish_at,note')
      .single();

    if (error) {
      // 失敗時は再同期
      await load();
      return;
    }
    if (data) {
      setProducts(prev => prev.map(p => p.id === id ? mapProduct(data as ProductsRow) : p));
    }
  }, [supabase, load]);



  // ── 予約公開の到来を検知して自動反映 ─────────────────────────────
  useEffect(() => {
    // 未来の publish_at を集計
    const now = Date.now();
    const future = products
      .map(p => p.publish_at ? Date.parse(p.publish_at) : NaN)
      .filter(ts => Number.isFinite(ts) && ts > now)
      .sort((a, b) => a - b);

    if (future.length === 0) return; // 次の予約がなければ何もしない

    const nextTs = future[0];
    const delay = Math.max(0, nextTs - now) + 500; // 500ms マージン
    const id = window.setTimeout(() => {
      // 軽く再同期（どちらでも可）
      // 1) サーバーと再同期したい場合
      load();
      // 2) 再フェッチ不要でローカル再評価だけで良い場合は下を使う
      // setProducts(prev => [...prev]); // 再レンダー誘発
    }, delay);

    return () => { window.clearTimeout(id); };
  }, [products, load]);


  return {
    products, perr, ploading,
    add, remove, updateStock, updatePickupSlot,
    updatePublishAt,
    updateNote,
    updateProduct,
    reload: load
  } as const;

}

// ===== Orders =====
function useOrders() {
  // 直近のイベント受信時刻（INSERT/UPDATE/DELETE）を記録して、無音時のみポーリングを走らせる
  const lastEventAtRef = useRef<number>(Date.now());
  const supabase = useSupabase();
  const invChan = useBroadcast('inventory-sync');
  const orderChan = useBroadcast('order-sync');

  const [orders, setOrders] = useState<Order[]>([]);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const chanName = `orders-realtime-${getStoreId()}`;
  // useOrders() の先頭付近に追加
  const upsertById = (list: Order[], row: Order) => {
    const i = list.findIndex(o => o.id === row.id);
    if (i >= 0) {
      const next = list.slice();
      next[i] = row;
      return next;
    }
    return [row, ...list];
  };
  const uniqById = (rows: Order[]) => {
    const m = new Map<string, Order>();
    for (const r of rows) m.set(r.id, r);
    // 直近が先頭になるように、最後に入ったものを優先しつつ逆順で返す
    return Array.from(m.values());
  };


  // --- フェイルセーフ用の軽量リフレッシュ（サブスクの貼り直しはしない）---
  const softRefresh = useCallback(async () => {
    if (!supabase) return;
    const sid = getStoreId();
    if (!String(sid || '').trim()) return;

    // 直近だけ薄く取る（最新 50 件）
    const { data, error } = await supabase
      .from('orders')
      .select('id,store_id,code,customer,items,total,placed_at,updated_at,status,pickup_start,pickup_end,redeem_request_at,redeemed_at')
      .eq('store_id', sid)
      .order('placed_at', { ascending: false })
      .limit(50);

    if (error) return; // ポーリングは失敗しても黙って次回
    const rows = ((data ?? []) as OrdersRow[]).map(mapOrder);

    // 既存配列にマージして重複排除（順序は最新優先）
    setOrders(prev => uniqById([...rows, ...prev]));
  }, [supabase, setOrders]);


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
    const sid = getStoreId();
    if (!String(sid || '').trim()) { setErr('店舗が未選択です。店舗を選択してください。'); setReady(true); return; }
    setErr(null); cleanup();
    const { data, error } = await supabase
      .from('orders')
      .select('id,store_id,code,customer,items,total,placed_at,status,pickup_start,pickup_end,redeem_request_at,redeemed_at')
      .eq('store_id', sid)
      .order('placed_at', { ascending: false });
    if (error) {
      setErr(error.message || 'データ取得に失敗しました');
    } else {
      const rows = ((data ?? []) as OrdersRow[]).map(mapOrder);
      setOrders(uniqById(rows));
    }
    try {
      const sid = getStoreId();
      const ch = (supabase as any)
        .channel(chanName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter: `store_id=eq.${sid}` }, (p: any) => {
          if (!p?.new) return;
          const row = mapOrder(p.new as OrdersRow);
          setOrders(prev => upsertById(prev, row));
          lastEventAtRef.current = Date.now();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${sid}` }, (p: any) => {
          if (!p?.new) return;
          const row = mapOrder(p.new as OrdersRow);
          setOrders(prev => upsertById(prev, row));
          lastEventAtRef.current = Date.now();
        })
        // NOTE: DELETE は REPLICA IDENTITY 設定次第で old に store_id が含まれないため、フィルタを外す
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'orders' }, (p: any) => {
          const oldRow = (p?.old as any) || {};
          const id = String(oldRow.id || '');
          if (!id) return;
          setOrders(prev => prev.filter(o => o.id !== id));
          lastEventAtRef.current = Date.now();
        })
        .subscribe() as RealtimeChannel;
      channelRef.current = ch;
    } catch { setErr('リアルタイム購読に失敗しました'); }
    setReady(true);
  }, [supabase, cleanup, chanName]);

  useEffect(() => { fetchAndSubscribe(); return () => { cleanup(); }; }, [fetchAndSubscribe, cleanup]);
  // --- フェイルセーフ：Realtime が無音のときだけ薄く再同期する ---
  // 15秒毎にチェックし、直近12秒イベントが無ければ softRefresh を実行
  useEffect(() => {
    const id = window.setInterval(() => {
      // 直近に Realtime で何か来ていればスキップ
      const silentMs = Date.now() - lastEventAtRef.current;
      if (silentMs < 12_000) return;
      // 無音が続いている場合のみ軽量再同期
      softRefresh();
      // 実行時点を「イベント」とみなし、連打しないように軽く更新
      lastEventAtRef.current = Date.now();
    }, 15_000);

    return () => { window.clearInterval(id); };
  }, [softRefresh]);


  // 新（RPC経由）:
  const fulfill = useCallback(async (id: string, opts?: { override?: boolean }) => {
    const target = orders.find(o => o.id === id);
    if (!target) return;

    // ここではDBの値を使って正規化（モーダル側の入力検証は既に通過している想定）
    const code = normalizeCode6(target.code ?? "");
    if (!code || code.length !== 6) {
      setErr('この注文にはコードが登録されていません');
      return;
    }

    if (!supabase) {
      // （念のため）クライアント未初期化時はローカルだけ更新
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'FULFILLED' } : o));
      orderChan.post({ type: 'ORDER_FULFILLED', orderId: id, at: Date.now() });
      return;
    }


    // ★ RPC 呼び出し（DB側で作成済みの fulfill_order(uuid, text) を使う）
    const { data, error } = await supabase.rpc('fulfill_order', {
      p_store_id: getStoreId(),
      p_code: code,
    });

    if (error) {
      setErr(error.message || '更新に失敗しました');
      return;
    }

    if (data) {
      // RPCの戻り値（更新後の行）で一覧を更新
      const row = data as any; // returns public.orders
      setOrders(prev =>
        prev.map(o => (o.id === String(row.id) ? mapOrder(row) : o)),
      );
      orderChan.post({ type: 'ORDER_FULFILLED', orderId: String(row.id), at: Date.now() });

      // TODO(req v2): fulfill_order 側で COMPLETED まで遷移＆通知トリガを内包する設計に統合。
      // 現状は UI 操作 → RPC（受け渡し）→ 即時 Push API で通知。失敗してもオペレーションは継続。
      try {
        fetch('/api/store/orders/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId: String(row.id) }),
        }).then(async (r) => {
          if (!r.ok) {
            console.warn('[complete] push api error', r.status, await r.text());
          }
        }).catch(() => {/* noop */ });
      } catch {/* noop */ }
    }
  }, [supabase, orders, orderChan, setOrders, setErr]);

  // 二段階引換: 受け取り確定依頼を送る
  const requestRedeem = useCallback(async (id: string) => {
    try {
      const r = await fetch('/api/store/orders/request-redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: id }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        emitToast('error', '依頼に失敗しました。もう一度お試しください。');
        return;
      }
      const nowIso = new Date().toISOString();
      setOrders(prev => prev.map(o => (
        o.id === id ? { ...o, redeemRequestedAt: (o as any).redeemRequestedAt || nowIso } : o
      )));
      emitToast('success', '受け取り確定の依頼を送信しました。');
    } catch {
      emitToast('error', '通信に失敗しました。時間をおいて再試行してください。');
    }
  }, [setOrders]);

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
  return { ready, err, orders, pending, fulfilled, fulfill, requestRedeem, clearPending, clearFulfilled, retry: fetchAndSubscribe } as const;
}


// 画面背面のスクロールをロック（iOS対応）
function useModalScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const prev = body.style.cssText;

    // 背面固定＋スクロール停止（iOS/SE対策）
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.touchAction = 'none';

    return () => {
      body.style.cssText = prev;
      window.scrollTo(0, scrollY); // 解除時に元の位置へ戻す
    };
  }, [open]);
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

const OrderCard = React.memo(function OrderCard({ order, onHandoff, onRequestRedeem }: { order: Order; onHandoff: (o: Order) => void; onRequestRedeem: (id: string) => void; }) {
  const onClick = useCallback(() => onHandoff(order), [onHandoff, order]);
  const mounted = useMounted();
  const supabase = useSupabase();
  const [presetLabelCur, setPresetLabelCur] = React.useState("");

  // 商品の pickup_slot_no から「店舗受取可能時間（プリセット）」を導出
  const { presets } = usePickupPresets();
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!supabase) return;
        const ids = Array.from(new Set((order.items || []).map(it => String(it.id || '').trim()).filter(Boolean)));
        if (ids.length === 0) { if (alive) setPresetLabelCur(''); return; }
        const { data: prows } = await (supabase as any)
          .from('products')
          .select('id,pickup_slot_no')
          .in('id', ids);
        const slots = new Set<number>();
        for (const r of prows || []) {
          const n = (r as any)?.pickup_slot_no;
          if (typeof n === 'number' && n >= 1 && n <= 3) slots.add(n);
        }
        if (slots.size === 0) { if (alive) setPresetLabelCur(''); return; }
        const labels: string[] = [];
        for (const n of Array.from(slots).sort()) {
          const p = (presets as any)[n as 1 | 2 | 3];
          if (p && p.start && p.end) labels.push(`${p.start}〜${p.end}`);
        }
        if (alive) setPresetLabelCur(labels.length ? labels.join(' / ') : (order.presetLabel ?? ''));
      } catch {
        if (alive) setPresetLabelCur('');
      }
    })();
    return () => { alive = false; };
  }, [supabase, order.items, presets]);
  const jpPickupRange = React.useMemo(() => {
    const fmt = (iso: string) => {
      try {
        return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
      } catch { return ''; }
    };
    const a = order.pickupStart ? fmt(order.pickupStart) : '';
    const b = order.pickupEnd ? fmt(order.pickupEnd) : '';
    if (a && b) return `${a}〜${b}`;
    if (a) return `${a}〜`;
    if (b) return `〜${b}`;
    return '未指定';
  }, [order.pickupStart, order.pickupEnd]);
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">{order.customer}</div>
        <div className="flex items-center gap-2">
          {(order as any).redeemRequestedAt ? (
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border bg-blue-50 text-blue-700 border-blue-200">受け取り確定待ち</span>
          ) : null}
          <StatusBadge status={order.status} />
        </div>
      </div>
      <div className="text-sm text-zinc-600">注文ID: {order.id}</div>
      <div className="text-sm text-zinc-700">受取時間: {jpPickupRange}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* <div className="text-sm">
          <div className="inline-block rounded-full border px-2 py-0.5 text-xs text-zinc-600 mb-1">注文時に選択した受取時間</div>
          <div className="text-zinc-800 font-medium">{jpPickupRange}</div>
        </div> */}
        <div className="text-sm">
          <div className="inline-block rounded-full border px-2 py-0.5 text-xs text-zinc-600 mb-1">店舗受取可能時間</div>
          <div className="text-zinc-800 font-medium">{presetLabelCur || '未設定'}</div>
        </div>
      </div>
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
        (order as any).redeemRequestedAt ? (
          <div className="w-full rounded-xl bg-blue-600/10 text-blue-700 py-2.5 text-sm text-center font-medium">受け取り確定待ち</div>
        ) : (
          <button onClick={onClick} className="w-full rounded-xl bg-zinc-900 text-white py-2.5 text-sm font-medium hover:bg-zinc-800 active:opacity-90">受け渡し（コード照合）</button>
        )
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
        {/* 端末のアスペクトに依らず“枠いっぱい”で見せる */}
        <div className="rounded-xl overflow-hidden mb-3 bg-black h-[60svh] sm:h-[65svh]">
          {/* 画面いっぱいに敷き詰める */}
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
        </div>

        {err ? <div className="text-sm text-red-600 mb-2">{err}</div> : null}
        <div className="text-right">
          <button className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}


function ScanChooser({
  onDetect,
  onClose,
}: {
  onDetect: (code: string) => void;
  onClose: () => void;
}) {
  const [useInternal, setUseInternal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // 画像ファイルから検出（カメラアプリ or ファイルマネージャから選択）
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!f) return;
    try {
      if (!("BarcodeDetector" in window)) {
        setErr("この端末は画像からの読み取りに対応していません（内蔵スキャナをご利用ください）");
        return;
      }
      const bmp = await createImageBitmap(f);
      const det = new (window as any).BarcodeDetector({
        formats: ["qr_code", "ean_13", "code_128"],
      });
      const codes = await det.detect(bmp);
      const raw = codes?.[0]?.rawValue ?? codes?.[0]?.rawText ?? "";
      const code = normalizeCode6(raw);
      if (code && code.length === 6) {
        onDetect(code);
        onClose();
      } else {
        setErr("読み取れませんでした。もう一度お試しください。");
      }
    } catch {
      setErr("読み取りに失敗しました。もう一度お試しください。");
    }
  };

  // 外部アプリを起動（Android: インテントで“アプリの選択”を促す）
  const openExternal = () => {
    const ua = navigator.userAgent || "";
    const isAndroid = /Android/i.test(ua);

    if (isAndroid) {
      // ZXing互換のスキャンIntent。packageを指定しないことで対応アプリの“選択”が出る端末が多いです。
      const intent =
        "intent://scan/#Intent;scheme=zxing;action=com.google.zxing.client.android.SCAN;S.MODE=QR_CODE;end";
      // 新規タブだとブロックされることがあるため、同一タブ遷移
      window.location.href = intent;
    } else {
      // iOSなど：専用スキームは端末依存のため内蔵/画像からの利用を案内
      setErr("外部スキャンアプリの呼び出しはこの端末では保証できません。内蔵スキャナか画像からの読み取りをご利用ください。");
    }
  };

  // 内蔵スキャナへ切り替えたら、そのまま既存のQRScannerを表示
  if (useInternal) {
    return (
      <QRScanner
        onDetect={(code) => {
          onDetect(code);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-2">QRを読み取る方法を選択</div>

        <div className="space-y-2">
          <button
            type="button"
            className="w-full rounded-xl border px-4 py-3 text-sm hover:bg-zinc-50"
            onClick={() => setUseInternal(true)}
          >
            ブラウザでスキャン（内蔵）
          </button>

          <button
            type="button"
            className="w-full rounded-xl border px-4 py-3 text-sm hover:bg-zinc-50"
            onClick={() => fileRef.current?.click()}
          >
            カメラで読み取り
          </button>

          <button
            type="button"
            className="w-full rounded-xl border px-4 py-3 text-sm hover:bg-zinc-50"
            onClick={openExternal}
          >
            外部アプリでスキャン（アプリを選択）
          </button>

          <p className="text-[11px] text-zinc-500">
            ※ 外部アプリは端末にインストール済みのQRコードアプリから選択できます（Android想定）。
            iOSでは内蔵スキャナか画像からの読み取りをご利用ください。
          </p>

          {err ? <div className="text-sm text-red-600">{err}</div> : null}
        </div>

        {/* 画像選択（capture=environment でカメラアプリも候補に出ます） */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onPick}
        />

        <div className="text-right mt-3">
          <button className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}


// ▼▼▼ 静止画カメラ撮影モーダル ▼▼▼
function CameraCaptureModal({
  open,
  title = "写真を撮影",
  onClose,
  onCapture, // (blob: Blob) => void
  facing = "environment", // "user" でインカメ
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  onCapture: (blob: Blob) => void;
  facing?: "environment" | "user";
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [isPreview, setIsPreview] = React.useState(false);
  const [facingMode, setFacingMode] = React.useState<"environment" | "user">(facing);

  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
        if (!active) {
          s.getTracks().forEach(t => t.stop());
          return;
        }
        setStream(s);
        const v = videoRef.current;
        if (v) {
          (v as any).srcObject = s;
          await v.play();
        }
      } catch (e) {
        setErr("カメラを起動できませんでした");
      }
    })();
    return () => {
      active = false;
      try { stream?.getTracks().forEach(t => t.stop()); } catch { }
      setStream(null);
    };
  }, [open, facingMode]);

  const doCapture = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;

    // 映像の読み込み完了を待つ
    if (v.readyState < 2) {
      await new Promise((resolve) => {
        const handler = () => {
          v.removeEventListener("loadeddata", handler);
          resolve(null);
        };
        v.addEventListener("loadeddata", handler);
      });
    }

    // 正しいサイズで描画
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);

    setIsPreview(true);
  };


  const confirmUse = async () => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (blob) onCapture(blob);
    }, "image/jpeg", 0.9);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold mb-2">{title}</div>

        {!isPreview ? (
          <div className="space-y-3">
            <div className="aspect-[4/3] bg-black/90 rounded-xl overflow-hidden">
              <video ref={videoRef} className="w-full h-full object-contain" playsInline muted />
            </div>
            {err ? <div className="text-sm text-red-600">{err}</div> : null}
            <div className="flex items-center justify-between">
              <button
                className="rounded-lg border px-3 py-2 text-sm"
                onClick={() => setFacingMode(m => (m === "environment" ? "user" : "environment"))}
                type="button"
              >
                カメラ切替
              </button>
              <button
                className="rounded-xl bg-zinc-900 text-white px-4 py-2 text-sm"
                onClick={doCapture}
                type="button"
              >
                撮影
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="aspect-[4/3] bg-black/90 rounded-xl overflow-hidden">
              <canvas ref={canvasRef} className="w-full h-full object-contain" />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => setIsPreview(false)} type="button">
                撮り直す
              </button>
              <button className="rounded-xl bg-zinc-900 text-white px-4 py-2 text-sm" onClick={confirmUse} type="button">
                この写真を使う
              </button>
            </div>
          </div>
        )}

        {/* キャンバスはプリビュー切替後に描画するため、常時置いておく */}
        <canvas ref={canvasRef} className="hidden" />
        <div className="text-right mt-2">
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={onClose} type="button">閉じる</button>
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

// 受け取り時間 変更モーダル（プリセットを1つ選ぶ）
function PickupSlotModal({
  open,
  productName,
  initial,           // 初期: 現在の slot_no (1|2|3)
  presets,
  onClose,
  onCommit,          // (val: 1|2|3) => void
  disabled,
}: {
  open: boolean;
  productName: string;
  initial: number | null;
  presets: Record<1 | 2 | 3, { name: string; start: string; end: string }>;
  onClose: () => void;
  onCommit: (val: 1 | 2 | 3) => void;
  disabled: boolean;
}) {
  const [val, setVal] = React.useState<number | null>(initial ?? 1);
  React.useEffect(() => { setVal(initial ?? 1); }, [initial, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold mb-1">受け取り時間を選択</div>
        <div className="text-sm text-zinc-600 mb-3">対象: {productName}</div>

        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <label key={n} className="flex items-center justify-between rounded-xl border px-3 py-2 cursor-pointer hover:bg-zinc-50">
              <div className="min-w-0">
                <div className="text-sm font-medium">{presets[n as 1 | 2 | 3]?.name}</div>
                <div className="text-xs text-zinc-600">{presets[n as 1 | 2 | 3]?.start}〜{presets[n as 1 | 2 | 3]?.end}</div>
              </div>
              <input
                type="radio"
                name="pickup-slot"
                className="ml-2"
                checked={val === n}
                onChange={() => setVal(n)}
              />
            </label>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border px-4 py-2 text-sm">キャンセル</button>
          <button
            onClick={() => { if (val === 1 || val === 2 || val === 3) onCommit(val as 1 | 2 | 3); }}
            disabled={disabled}
            className={`rounded-xl px-4 py-2 text-sm text-white ${disabled ? "bg-zinc-400 cursor-not-allowed" : "bg-zinc-900 hover:bg-zinc-800"}`}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ひとこと編集モーダル（300文字まで）
function NoteEditModal({
  open,
  productName,
  initial,         // 初期値（null/undefinedなら空文字）
  onClose,
  onCommit,        // (next: string | null) => void
  disabled,
}: {
  open: boolean;
  productName: string;
  initial: string | null | undefined;
  onClose: () => void;
  onCommit: (val: string | null) => void;
  disabled: boolean;
}) {
  const [val, setVal] = React.useState<string>("");
  React.useEffect(() => {
    if (!open) return;
    setVal(String(initial ?? "").slice(0, 300));
  }, [open, initial]);

  if (!open) return null;

  const remain = 300 - (val?.length ?? 0);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border p-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold mb-1">「お店からのひとこと」を編集</div>
        <div className="text-sm text-zinc-600 mb-3">対象: {productName}</div>

        <textarea
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-300"
          placeholder="例）おすすめ商品です。数量限定につきお早めに！"
          rows={6}
          maxLength={300}
          value={val}
          onChange={(e) => setVal(e.target.value.slice(0, 300))}
          autoFocus
        />
        <div className="mt-1 text-right text-[11px] text-zinc-500">{val.length}/300</div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border px-4 py-2 text-sm" disabled={disabled}>キャンセル</button>
          <button
            onClick={() => onCommit((val ?? "").trim() ? (val ?? "").trim() : null)}
            className={`rounded-xl px-4 py-2 text-sm text-white ${disabled ? 'bg-zinc-400 cursor-not-allowed' : 'bg-zinc-900 hover:bg-zinc-800'}`}
            disabled={disabled}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// 登録済み商品のフル編集モーダル
function EditProductModal({
  open,
  product,
  presets,
  disabled,
  onClose,
  onCommit, // (patch) => Promise<void>
}: {
  open: boolean;
  product: Product;
  presets: Record<1 | 2 | 3, { name: string; start: string; end: string }>;
  disabled: boolean;
  onClose: () => void;
  onCommit: (patch: {
    name: string;
    price: number;
    stock: number;
    pickup_slot_no: number | null;
    publish_at: string | null;
    note: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = React.useState(product.name);
  const [price, setPrice] = React.useState(String(product.price));
  const [stock, setStock] = React.useState(String(product.stock));
  const [slot, setSlot] = React.useState<number | null>(product.pickup_slot_no ?? null);

  const [stockDlgOpen, setStockDlgOpen] = React.useState(false); // ← 在庫調整モーダルの開閉

  // 予約/即時 切替（予約なら datetime-local を編集）
  const isScheduled = !!product.publish_at && Date.parse(product.publish_at) > Date.now();
  const [pubMode, setPubMode] = React.useState<'now' | 'schedule'>(isScheduled ? 'schedule' : 'now');
  const [publishLocal, setPublishLocal] = React.useState<string>(() => {
    if (!product.publish_at) return '';
    try {
      const d = new Date(product.publish_at);
      // ローカルのYYYY-MM-DDTHH:mm
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  });
  const [note, setNote] = React.useState(String(product.note ?? '').slice(0, 300));

  // 画像は即時更新（既存の ProductImageSlot をこのモーダル内でも使える）
  if (!open) return null;

  useModalScrollLock(open);


  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4 overscroll-contain" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl border p-4
             max-h-[calc(100svh-2rem)] overflow-y-auto
             sm:max-h-[calc(100svh-4rem)]
             pb-[calc(env(safe-area-inset-bottom)+1.5rem)]" onClick={(e) => e.stopPropagation()}>
        <div className="text-base font-semibold mb-2">内容を変更（{product.name}）</div>
        <div className="grid grid-cols-1 gap-2">

          <div>
            <label className="block text-xs text-zinc-600 mb-1">商品名</label>
            <input className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-zinc-600 mb-1">価格</label>
              <div className="flex items-center gap-2">
                <input className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm [appearance:textfield]"
                  type="number" inputMode="numeric" min={1} step={1}
                  value={price} onChange={e => setPrice(e.target.value)} />
                <span className="text-sm text-zinc-500">円</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">在庫</label>
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm [appearance:textfield]"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={stock}
                  onChange={e => setStock(e.target.value)}
                />
                <span className="text-sm text-zinc-500">個</span>

                {/* 以前の「+5」などがある在庫調整モーダルを開く */}
                <button
                  type="button"
                  className="shrink-0 rounded-xl border px-3 py-2 text-sm bg-white hover:bg-zinc-50"
                  onClick={() => setStockDlgOpen(true)}
                  disabled={disabled}
                >
                  在庫変更
                </button>
              </div>
            </div>

          </div>

          <div>
            <label className="block text-xs text-zinc-600 mb-1">受け取り時間</label>
            <select
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white"
              value={slot === null ? '' : String(slot)}
              onChange={(e) => setSlot(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">未指定</option>
              <option value="1">{presets[1]?.name}（{presets[1]?.start}〜{presets[1]?.end}）</option>
              <option value="2">{presets[2]?.name}（{presets[2]?.start}〜{presets[2]?.end}）</option>
              <option value="3">{presets[3]?.name}（{presets[3]?.start}〜{presets[3]?.end}）</option>
            </select>
          </div>

          {/* 画像（即時反映型） */}
          <div>
            <label className="block text-xs text-zinc-600 mb-1">商品画像</label>
            <div className="grid grid-cols-3 gap-2">
              <ProductImageSlot
                mode="existing"
                productId={product.id}
                slot="main"
                label="メイン"
                path={product.main_image_path}
                onReload={async () => { }}
                // ★ モーダルでは「カメラ」「変更」
                actions={{ secondary: 'change' }}
              />
              <ProductImageSlot
                mode="existing"
                productId={product.id}
                slot="sub1"
                label="サブ1"
                path={product.sub_image_path1}
                onReload={async () => { }}
                // ★ モーダルでは「カメラ」「削除」
                actions={{ secondary: 'delete' }}
              />
              <ProductImageSlot
                mode="existing"
                productId={product.id}
                slot="sub2"
                label="サブ2"
                path={product.sub_image_path2}
                onReload={async () => { }}
                // ★ モーダルでは「カメラ」「削除」
                actions={{ secondary: 'delete' }}
              />
            </div>
            <p className="mt-2 text-[11px] text-zinc-600">メインは必須／サブは任意。タップして画像を選択してください。</p>
          </div>

          <div>
            <label className="block text-xs text-zinc-600 mb-1">お店からのひとこと（任意）</label>
            <textarea
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              rows={4} maxLength={300}
              value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))}
              placeholder="例）おすすめ商品です。数量限定につきお早めに！"
            />
            <div className="mt-1 text-right text-[11px] text-zinc-500">{note.length}/300</div>
          </div>

          {/* <div>
            <label className="block text-xs text-zinc-600 mb-1">公開</label>
            <div className="w-full rounded-lg border border-zinc-300 overflow-hidden bg-white">
              <div className="grid grid-cols-2 divide-x divide-zinc-300">
                <label className="flex items-center justify-center gap-2 py-2 text-sm cursor-pointer">
                  <input type="radio" name="pub-edit" checked={pubMode === 'now'} onChange={() => setPubMode('now')} />
                  <span>今すぐ公開</span>
                </label>
                <label className="flex items-center justify-center gap-2 py-2 text-sm cursor-pointer">
                  <input type="radio" name="pub-edit" checked={pubMode === 'schedule'} onChange={() => setPubMode('schedule')} />
                  <span>予約して公開</span>
                </label>
              </div>
            </div>
            {pubMode === 'schedule' && (
              <div className="mt-2">
                <input
                  type="datetime-local"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white"
                  value={publishLocal}
                  onChange={(e) => setPublishLocal(e.target.value)}
                  step={60}
                />
              </div>
            )}
          </div> */}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose} disabled={disabled}>キャンセル</button>
            <button
              type="button"
              className={`rounded-xl px-4 py-2 text-sm text-white ${disabled ? 'bg-zinc-400' : 'bg-zinc-900 hover:bg-zinc-800'}`}
              onClick={async () => {
                // バリデーション
                const priceNum = Math.max(0, Math.floor(Number(price || 0)));
                const stockNum = Math.max(0, Math.floor(Number(stock || 0)));
                if (!name.trim()) { alert('商品名は必須です'); return; }
                if (!Number.isFinite(priceNum) || priceNum < 1) { alert('価格は1以上の整数で入力してください'); return; }
                if (!Number.isFinite(stockNum) || stockNum < 0) { alert('在庫は0以上の整数で入力してください'); return; }

                let publishISO: string | null = null;
                if (pubMode === 'schedule') {
                  if (!publishLocal) { alert('公開開始の日時を入力してください'); return; }
                  publishISO = new Date(publishLocal.replace(' ', 'T')).toISOString();
                }

                await onCommit({
                  name: name.trim(),
                  price: priceNum,
                  stock: stockNum,
                  pickup_slot_no: slot ?? null,
                  publish_at: publishISO,
                  note: (note ?? '').trim() ? (note ?? '').trim().slice(0, 300) : null,
                });
              }}
              disabled={disabled}
            >
              保存
            </button>
            {/* 在庫調整モーダル（＋1/＋5/＋10 等のボタンUI） */}
            <StockAdjustModal
              open={stockDlgOpen}
              initial={Math.max(0, Math.floor(Number(stock || 0)))}
              productName={product.name}
              disabled={disabled}
              onClose={() => setStockDlgOpen(false)}
              onCommit={(val) => {
                // モーダルで確定した値を、この編集モーダルの在庫入力へ反映
                setStock(String(Math.max(0, Math.floor(Number(val || 0)))));
                setStockDlgOpen(false);
              }}
            />

          </div>
        </div>
      </div>
    </div>
  );
}



function useImageUpload() {
  const supabase = useSupabase();
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
    if (!sid) throw new Error("店舗IDが未設定です（セッション）");
    if (String(before.store_id ?? "") !== String(sid)) {
      throw new Error("他店舗の商品は更新できません");
    }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `products/${productId}/${slot}-${Date.now()}.${ext}`;

    // 1) Storage へアップロード
    const up = await supabase.storage.from("public-images").upload(path, file, {
      cacheControl: "31536000",
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

  const deleteProductImage = useCallback(async (productId: string, slot: Slot) => {
    if (!supabase) throw new Error("Supabase 未初期化");

    // 該当商品の store_id と現在の画像パスを取得
    const { data: before, error: fetchErr } = await supabase
      .from("products")
      .select("store_id, main_image_path, sub_image_path1, sub_image_path2")
      .eq("id", productId)
      .single();
    if (fetchErr) throw fetchErr;

    const sid = getStoreId();
    if (!before) throw new Error("対象商品が存在しません");
    if (!sid) throw new Error("店舗IDが未設定です（セッション）");
    if (String(before.store_id ?? "") !== String(sid)) {
      throw new Error("他店舗の商品は更新できません");
    }

    // スロットに紐づく現行パスを取り出し
    const col = colOf(slot);
    const currentPath =
      slot === "main" ? before.main_image_path :
        slot === "sub1" ? before.sub_image_path1 :
          before.sub_image_path2;

    if (!currentPath) return; // 既に空なら何もしない

    // 1) DB を null に更新（store_id で二重限定）
    const upd = await supabase
      .from("products")
      .update({ [col]: null })
      .eq("id", productId)
      .eq("store_id", sid);
    if (upd.error) throw upd.error;

    // 2) ストレージから物理削除（失敗しても致命ではないので握りつぶし）
    await supabase.storage.from("public-images").remove([currentPath]).catch(() => { });

    return true;
  }, [supabase]);


  return { uploadProductImage, deleteProductImage };
}

// 画像最適化版アップロードフック（サーバーAPI委譲）
function useImageUploadV2() {
  // 失敗時フォールバック用（クライアント直アップロード）
  const direct = useImageUpload();
  const supabase = useSupabase();
  const colOf = (slot: Slot) =>
    slot === "main" ? "main_image_path" :
      slot === "sub1" ? "sub_image_path1" : "sub_image_path2";

  const uploadProductImage = React.useCallback(async (productId: string, file: File, slot: Slot) => {
    try {
      const fd = new FormData();
      fd.append("productId", productId);
      fd.append("slot", slot);
      fd.append("file", file);
      const res = await fetch("/api/images/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "upload_failed");
      }
      const json = await res.json();
      const path = String(json.path || "");
      // 互換のため、API成功後にも列更新をクライアント側で冪等に実行
      try {
        if (supabase && path) {
          await supabase
            .from("products")
            .update({ [colOf(slot)]: path })
            .eq("id", productId)
            .eq("store_id", getStoreId());
        }
      } catch { /* noop */ }
      return path;
    } catch (e) {
      // 開発環境などで API へ接続できない場合のフォールバック
      // TODO(req v2): 本番では必ずサーバーAPI経由に統一（RLS/監査のため）
      return await direct.uploadProductImage(productId, file, slot);
    }
  }, [direct, supabase]);

  const deleteProductImage = React.useCallback(async (productId: string, slot: Slot) => {
    try {
      const res = await fetch("/api/images/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, slot }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "delete_failed");
      }
      return true;
    } catch (e) {
      // フォールバック: クライアント直削除
      return await direct.deleteProductImage(productId, slot);
    }
  }, [direct]);

  return { uploadProductImage, deleteProductImage };
}

// ▼ 画像スロット共通カード（登録済み/新規どちらでも使える）
// type Slot = "main" | "sub1" | "sub2";
type StagedProps = {
  mode: "staged";                 // 新規登録フォーム用（Fileを保持してsubmit時に一括アップ）
  label: string;                  // メイン / サブ1 / サブ2
  required?: boolean;
  file: File | null;              // 現在のFile
  onChange: (f: File | null) => void;
  actions?: { secondary: 'delete' | 'change' }; // ★ 追加（モーダル用：メインは'change'、サブは'delete'）
  readonly?: boolean; // 出品一覧のサムネを閲覧専用にする
};
type ExistingProps = {
  mode: "existing";               // 登録済み商品の即時更新
  productId: string;
  slot: Slot;
  label: string;
  path: string | null;            // Supabase Storage のパス
  imgVer?: number;                // キャッシュ破り
  onReload: () => Promise<void>;  // 親のreload（DB再読込）
  actions?: { secondary: 'delete' | 'change' }; // ★ 追加（モーダル用：メインは'change'、サブは'delete'）
  readonly?: boolean;
};

function ProductImageSlot(props: StagedProps | ExistingProps) {
  const { uploadProductImage, deleteProductImage } = useImageUploadV2();
  const [openCam, setOpenCam] = React.useState(false); // 既存のままでOK（使わなくなる）
  const pickerRef = React.useRef<HTMLInputElement | null>(null);   // ギャラリー
  const cameraRef = React.useRef<HTMLInputElement | null>(null);   // カメラ
  const [loading, setLoading] = React.useState(false);
  // ▼ 既存商品のモーダル内プレビューを即時反映するためのローカル状態
  const isExisting = (props as any).mode === "existing";
  const [currentPath, setCurrentPath] = React.useState<string | null>(
    isExisting ? (props as any).path ?? null : null
  );
  const [localVer, setLocalVer] = React.useState(0);
  // 親が reload して props.path が変わったときは同期（一覧側でも破綻しない）
  React.useEffect(() => {
    if (!isExisting) return;
    setCurrentPath((props as any).path ?? null);
  }, [isExisting ? (props as any).path : null]);

  // 共通見た目クラス
  const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="rounded-[14px] border border-zinc-300 bg-white p-2">{children}</div>
  );
  const ThumbButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
    <button
      type="button"
      onClick={onClick}
      className="relative w-full aspect-square rounded-[12px] overflow-hidden bg-zinc-100 border border-zinc-300 flex items-center justify-center group focus:outline-none focus:ring-2 focus:ring-red-400/60"
    >
      {children}
      <span className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-black/5" />
    </button>
  );

  // プレビュー（stagedのみFileから）
  const [preview, setPreview] = React.useState<string | null>(null);
  // blob: の ObjectURL は依存対象を props 全体にせず、選択中の File のみを監視
  // NOTE: props 参照全体を依存にすると再描画毎に revoke され、ERR_FILE_NOT_FOUND になる
  const stagedFile = props.mode === "staged" ? props.file : null;
  React.useEffect(() => {
    if (props.mode !== "staged") {
      setPreview(null);
      return;
    }
    if (!stagedFile) { setPreview(null); return; }
    const url = URL.createObjectURL(stagedFile);
    setPreview(url);
    return () => { URL.revokeObjectURL(url); };
  }, [props.mode, stagedFile]);

  const isReadonly = (props as any).readonly === true;

  // サムネの中身
  const renderThumb = () => {
    const label = props.label;
    const addOrChange =
      props.mode === "staged" ? (preview ? "変更" : "追加")
        : (props.path ? "変更" : "追加");

    let imgEl: React.ReactNode = <span className="text-3xl">{label === "メイン" ? "📷" : "🖼️"}</span>;
    if (props.mode === "staged" && preview) {
      imgEl = <img src={preview} alt={`${label}`} className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]" />;
    }
    if (props.mode === "existing" && (currentPath ?? props.path)) {
      const effectivePath = currentPath ?? props.path!;
      imgEl = (
        <img
          src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-images/${effectivePath}`}
          alt={label}
          className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
          loading="lazy"
          decoding="async"
          width={800}
          height={800}
        />
      );
    }

    return (
      <>
        {imgEl}
        {/* 左上ラベル */}
        <span className="absolute top-1 left-1 px-1.5 py-[2px] text-[11px] rounded-full bg-white/95 border border-zinc-300 text-zinc-700 shadow-[0_0_0_1px_rgba(0,0,0,0.02)]">
          {label}{(props as StagedProps).required ? " *" : ""}
        </span>
        {/* 右下バッジ */}
        {/* 右下バッジ：閲覧専用では出さない */}
        {!isReadonly && (
          <span className="absolute bottom-1 right-1 px-1.5 py-[2px] text-[11px] rounded-md bg-white/95 border border-zinc-300 text-zinc-700">
            {addOrChange}
          </span>
        )}
        {loading && (
          <div className="absolute inset-0 grid place-items-center text-xs bg-white/70">更新中…</div>
        )}
      </>
    );
  };

  // ギャラリー選択（captureなし）
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0] || null;
    e.currentTarget.value = "";
    if (props.mode === "staged") {
      props.onChange(f);
      (async () => {
        const small = f ? await downscaleFile(f, { max: 1080, quality: 0.9 }) : null;
        props.onChange(small);
      })();
    } else if (props.mode === "existing" && f) {
      (async () => {
        try {
          setLoading(true);
          const small = await downscaleFile(f, { max: 1080, quality: 0.9 });
          const newPath = await uploadProductImage(props.productId, small, props.slot);
          setCurrentPath(String(newPath || null));
          setLocalVer(v => v + 1);
          await props.onReload();
          alert(`${props.label}画像を更新しました`);
        } catch (err: any) {
          alert(`アップロードに失敗しました: ${err?.message ?? err}`);
        } finally { setLoading(false); }
      })();
    }
  };

  // カメラ撮影で受け取ったBlobをFile化して共通処理へ
  const onCaptured = (blob: Blob) => {
    const file = new File([blob], "camera.jpg", { type: blob.type || "image/jpeg" });
    if (props.mode === "staged") {
      (async () => {
        const small = await downscaleFile(file, { max: 1080, quality: 0.9 });
        props.onChange(small);
      })();
    } else if (props.mode === "existing") {
      (async () => {
        try {
          setLoading(true);
          const small = await downscaleFile(file, { max: 1080, quality: 0.9 });
          const newPath = await uploadProductImage(props.productId, small, props.slot);
          // モーダル内サムネを即時更新
          setCurrentPath(String(newPath || null));
          setLocalVer(v => v + 1);
          // 親の再同期（一覧側）も従来どおり実施
          await props.onReload();
          alert(`${props.label}画像を更新しました`);
        } catch (e: any) {
          alert(`アップロードに失敗しました: ${e?.message ?? e}`);
        } finally { setLoading(false); }
      })();
    }
  };

  // 削除処理
  const onDelete = () => {
    if (props.mode === "staged") {
      props.onChange(null);
    } else {
      if (!confirm(`${props.label}画像を削除しますか？`)) return;
      (async () => {
        try {
          setLoading(true);
          await deleteProductImage(props.productId, props.slot);
          // ▼ 即時にプレビューを消す
          setCurrentPath(null);
          setLocalVer(v => v + 1);
          await props.onReload();
          alert(`${props.label}画像を削除しました`);
        } catch (e: any) {
          alert(`削除に失敗しました: ${e?.message ?? e}`);
        } finally { setLoading(false); }
      })();
    }
  };

  const hasImage = props.mode === "staged" ? !!props.file : !!props.path;
  type ActionCfg = { secondary: 'delete' | 'change' } | null;
  const actions: ActionCfg = (props as any).actions ?? null; // ★ JSXに書かない！

  return (
    <Card>
      {/* サムネ：閲覧専用ならクリック不可の <div>、通常は従来どおりボタン */}
      {isReadonly ? (
        <div className="relative w-full aspect-square rounded-[12px] overflow-hidden bg-zinc-100 border border-zinc-300 flex items-center justify-center">
          {renderThumb()}
        </div>
      ) : (
        <ThumbButton onClick={() => pickerRef.current?.click()}>
          {renderThumb()}
        </ThumbButton>
      )}


      {/* 隠し input：ギャラリー用 / カメラ用 の2本 */}
      {!isReadonly && (
        <>
          {/* ギャラリー（ファイルマネージャー等）。capture なし */}
          <input
            ref={pickerRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPick}
          />
          {/* カメラ（端末のカメラアプリを優先起動 or 候補に表示） */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPick}
          />
        </>
      )}
      {/* // ★ モーダル用のアクション上書き（任意）
      //   - actions.secondary: 'delete' | 'change'
      //     'change' は「変更」ボタンとしてファイル選択を開く */}

      {/* 縦積みボタン（新規登録フォーム or モーダル上書き時に表示） */}
      {(props.mode === "staged" || actions) && !isReadonly && (
        <div className="mt-2 flex flex-col gap-1">
          {/* カメラで撮る（カメラ用 input を叩く） */}
          <button
            type="button"
            className="w-full rounded-lg border px-2 py-1 text-[11px] hover:bg-zinc-50"
            onClick={() => cameraRef.current?.click()}
            disabled={loading}
          >
            カメラで撮る
          </button>

          {/* ファイルから選ぶ（従来のギャラリー） */}
          <button
            type="button"
            className="w-full rounded-lg border px-2 py-1 text-[11px] hover:bg-zinc-50"
            onClick={() => pickerRef.current?.click()}
            disabled={loading}
          >
            ファイルから選ぶ
          </button>

          {/* 削除 or 変更（モーダルのメイン画像は「変更」） */}
          <button
            type="button"
            className={`w-full rounded-lg border px-2 py-1 text-[11px] ${actions?.secondary === 'change'
              ? ''
              : 'text-red-600 border-red-300 hover:bg-red-50'
              } disabled:opacity-40`}
            onClick={() => {
              if (actions?.secondary === 'change') {
                // 「変更」= ファイル選択ダイアログを開く
                pickerRef.current?.click();
              } else {
                onDelete();
              }
            }}
            disabled={loading || (!hasImage && props.mode === "staged" && actions?.secondary !== 'change')}
          >
            {actions?.secondary === 'change' ? '変更' : '削除'}
          </button>
        </div>
      )}

      {/* 内蔵のカメラモーダル（既存のを流用） */}
      {openCam && !isReadonly && (
        <CameraCaptureModal
          open={true}
          title={`${props.label}画像を撮影`}
          onClose={() => setOpenCam(false)}
          onCapture={(b) => { onCaptured(b); setOpenCam(false); }}
          facing="environment"
        />
      )}
    </Card>
  );
}



function ProductForm() {
  useEnsureAuth(); // ★ 追加：匿名ログインで authenticated を確保
  const { products, perr, ploading, add, remove, updateStock, updatePickupSlot, updateNote, updateProduct, reload } = useProducts();
  // ★ 画像のキャッシュ破り用バージョン
  const [imgVer, setImgVer] = useState(0);
  const [adjust, setAdjust] = useState<null | { id: string; name: string; stock: number }>(null);
  const [pending, setPending] = useState<Record<string, { id: string; name: string; current: number; next: number }>>({});
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("");



  // ▼ 既存商品の「ひとこと」編集用
  const [noteDlg, setNoteDlg] = useState<null | { id: string; name: string; note: string }>(null);
  const [editDlg, setEditDlg] = useState<null | Product>(null);


  const [pickupSlotForNew, setPickupSlotForNew] = useState<number | null>(null); // null=未指定
  // ▼ メイン画像（必須）
  const [mainImageFile, setMainImageFile] = useState<File | null>(null);
  // ▼ サブ画像（任意：2枚まで）
  const [subImageFile1, setSubImageFile1] = useState<File | null>(null);
  const [subImageFile2, setSubImageFile2] = useState<File | null>(null);
  // ▼ 画像プレビューURL（ObjectURL）
  const [imgPreview, setImgPreview] = useState<{ main?: string; sub1?: string; sub2?: string }>({});

  // ファイル選択→プレビュー更新（メモリ解放込み）
  useEffect(() => {
    const next: { main?: string; sub1?: string; sub2?: string } = {};
    if (mainImageFile) next.main = URL.createObjectURL(mainImageFile);
    if (subImageFile1) next.sub1 = URL.createObjectURL(subImageFile1);
    if (subImageFile2) next.sub2 = URL.createObjectURL(subImageFile2);
    setImgPreview(next);
    return () => {
      try { if (next.main) URL.revokeObjectURL(next.main); } catch { }
      try { if (next.sub1) URL.revokeObjectURL(next.sub1); } catch { }
      try { if (next.sub2) URL.revokeObjectURL(next.sub2); } catch { }
    };
  }, [mainImageFile, subImageFile1, subImageFile2]);

  const subImageInputRef1 = useRef<HTMLInputElement | null>(null);
  const subImageInputRef2 = useRef<HTMLInputElement | null>(null);

  const mainImageInputRef = useRef<HTMLInputElement | null>(null);
  // ▼ フォーム用：ギャラリー選択（capture なし）の input を3本
  const mainPickerRef = useRef<HTMLInputElement | null>(null);
  const sub1PickerRef = useRef<HTMLInputElement | null>(null);
  const sub2PickerRef = useRef<HTMLInputElement | null>(null);


  const take = storeTake(Number(price || 0));
  const { uploadProductImage, deleteProductImage } = useImageUploadV2();
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  // 登録フォームに「公開タイミング」を追加
  const [publishMode, setPublishMode] = useState<'now' | 'schedule'>('now');
  const [publishLocal, setPublishLocal] = useState<string>(''); // 'YYYY-MM-DDTHH:mm' （ローカル）
  // ▼ フォーム用：カメラ撮影モーダルの制御（登録済みと同じモーダルを使う）
  const [formCam, setFormCam] = useState<null | { slot: "main" | "sub1" | "sub2"; label: string }>(null);


  // ▼▼ ギャラリー（モーダル）用 state
  const [gallery, setGallery] = useState<null | {
    id: string;
    name: string;
    paths: string[]; // [main, sub1, sub2] の有効なものだけを詰める
  }>(null);
  // カメラ撮影モーダル用 state
  const [cam, setCam] = useState<null | {
    productId: string;
    slot: "main" | "sub1" | "sub2";
    label: string;
    name: string; // 商品名（トースト用）
  }>(null);

  const [gIndex, setGIndex] = useState(0);
  // ▼ 未反映の合計差分（バッジ表示用）
  const totalDelta = useMemo(() => {
    const list = Object.values(pending);
    const sum = list.reduce((acc, it) => acc + (it.next - it.current), 0);
    return { sum, count: list.length };
  }, [pending]);
  const { presets } = usePickupPresets();
  // 受け取り時間ラベル（名称＋時刻）を作る
  const labelForSlot = useCallback((slot: number | null | undefined) => {
    if (slot == null) return "未設定";
    const s = presets[slot as 1 | 2 | 3];
    return s ? `${s.name}（${s.start}〜${s.end}）` : "未設定";
  }, [presets]);

  // 編集中の商品IDと一時値
  const [editPickupId, setEditPickupId] = useState<string | null>(null);
  const [editPickupVal, setEditPickupVal] = useState<number | null>(null);
  // 受け取り時間 変更モーダル用 state
  const [pickupDlg, setPickupDlg] = useState<null | { id: string; name: string; current: number | null }>(null);
  // ▼ やさしいトースト（非モーダル）
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const gentleWarn = useCallback((msg: string) => {
    setToastMsg(msg);
    // 2秒で自動消去
    setTimeout(() => setToastMsg(null), 2000);
  }, []);

  return (
    <div className="rounded-2xl border bg-white p-4 space-y-3">
      <SectionTitle>商品登録</SectionTitle>
      <form
        className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-3 items-start"
        onSubmit={async (e) => {
          e.preventDefault();

          const nameOk = name.trim().length > 0;
          const priceNum = Math.floor(Number(price));
          const stockNum = Math.floor(Number(stock));
          const priceOk = Number.isFinite(priceNum) && priceNum >= 1;
          const stockOk = Number.isFinite(stockNum) && stockNum >= 0;
          const pickupOk = pickupSlotForNew !== null;

          if (!nameOk) { alert('商品名は必須です'); return; }
          if (!priceOk) { alert('価格は1以上の整数で入力してください'); return; }
          if (!stockOk) { alert('在庫は0以上の整数で入力してください'); return; }
          if (!pickupOk) { alert('受け取り時間を選択してください'); return; }
          if (!mainImageFile) { alert('メイン画像を選択してください'); return; }

          // 予約 ISO を作成（予約モードのときだけ）
          let publishISO: string | null = null;
          if (publishMode === 'schedule') {
            if (!publishLocal) { alert('公開開始の日時を入力してください'); return; }
            const local = publishLocal; // 'YYYY-MM-DDTHH:mm'
            publishISO = new Date(local.replace(' ', 'T')).toISOString();
          }

          // 1) まず商品レコードを作成
          const created = await add({
            name: name.trim(),
            price: priceNum,
            stock: stockNum,
            pickup_slot_no: pickupSlotForNew,
            publish_at: publishISO,
            note: note.trim() || null,
          });

          if (!created) return;

          // 2) 直後にメイン画像を必須アップロード
          try {
            await uploadProductImage(created.id, mainImageFile, "main");
            await reload();
            setImgVer(v => v + 1);
            alert('メイン画像を登録しました');
            // ▼ サブ画像（任意）：失敗しても商品はロールバックしない（メインは既にOKのため）
            try {
              if (subImageFile1) {
                await uploadProductImage(created.id, subImageFile1, "sub1");
              }
              if (subImageFile2) {
                await uploadProductImage(created.id, subImageFile2, "sub2");
              }
            } catch (e) {
              console.warn('[image] sub upload failed', e);
              emitToast?.('error' as any, '一部のサブ画像のアップロードに失敗しました（後から登録/変更できます）');
            }

          } catch (err: any) {
            // アップロード失敗時は商品をロールバック（必須要件を満たせないため）
            try { await remove(created.id); } catch { }
            alert(`メイン画像のアップロードに失敗しました: ${err?.message ?? err}`);
            return;
          }

          // 3) クリア
          setName(""); setPrice(""); setStock("");
          setNote("");
          setPickupSlotForNew(null);
          setPublishMode('now'); setPublishLocal("");
          setMainImageFile(null);
          setSubImageFile1(null);
          setSubImageFile2(null);
          if (subImageInputRef1.current) subImageInputRef1.current.value = "";
          if (subImageInputRef2.current) subImageInputRef2.current.value = "";
          if (mainImageInputRef.current) mainImageInputRef.current.value = "";
          if (mainPickerRef.current) mainPickerRef.current.value = "";
          if (sub1PickerRef.current) sub1PickerRef.current.value = "";
          if (sub2PickerRef.current) sub2PickerRef.current.value = "";

        }}
      >

        {/* 商品名（2カラムまたぎ） */}
        <div className="md:col-span-2">
          <label className="block text-xs text-zinc-600 mb-1">商品名</label>
          <input
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-300"
            placeholder="商品名"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
        </div>


        {/* 価格 */}
        <div>
          <label className="block text-xs text-zinc-600 mb-1">価格</label>
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-zinc-300"
              placeholder="0"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={price}
              onChange={e => setPrice(e.target.value)}
              required
            />
            <span className="shrink-0 text-sm text-zinc-500">円</span>
          </div>
        </div>

        {/* 店側受取額（サマリ行・右寄せ） */}
        <div className="md:col-span-2 flex items-center justify-between pt-1">
          <span className="text-xs text-zinc-500">手数料差引後</span>
          <span className="text-xs font-medium text-zinc-800 tabular-nums">
            店側受取額 {yen(take)}
          </span>
        </div>

        {/* 在庫 */}
        <div>
          <label className="block text-xs text-zinc-600 mb-1">在庫</label>
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-zinc-300"
              placeholder="0"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={stock}
              onChange={e => setStock(e.target.value)}
              required
            />
            <span className="shrink-0 text-sm text-zinc-500">個</span>
          </div>
        </div>

        {/* 受け取り時間（プリセット） */}
        <div>
          <label className="block text-xs text-zinc-600 mb-1">受け取り時間</label>
          <select
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-300"
            value={pickupSlotForNew === null ? '' : String(pickupSlotForNew)}
            onChange={(e) => {
              const v = e.target.value;
              setPickupSlotForNew(v === '' ? null : Number(v));
            }}
            aria-label="受取プリセット"
            title="受取プリセット"
          >
            <option value="">未指定</option>
            <option value="1">{presets[1]?.name}（{presets[1]?.start}〜{presets[1]?.end}）</option>
            <option value="2">{presets[2]?.name}（{presets[2]?.start}〜{presets[2]?.end}）</option>
            <option value="3">{presets[3]?.name}（{presets[3]?.start}〜{presets[3]?.end}）</option>
          </select>
        </div>

        {/* 商品画像（メイン1＋サブ2） / 登録済みと同様の3サムネUI */}
        {/* 商品画像（メイン1＋サブ2） / 共通カードで統一 */}
        <div className="md:col-span-2">
          <label className="block text-xs text-zinc-600 mb-1">商品画像</label>
          <div className="grid grid-cols-3 gap-2">
            <ProductImageSlot
              mode="staged"
              label="メイン"
              required
              file={mainImageFile}
              onChange={setMainImageFile}
            />
            <ProductImageSlot
              mode="staged"
              label="サブ1"
              file={subImageFile1}
              onChange={setSubImageFile1}
            />
            <ProductImageSlot
              mode="staged"
              label="サブ2"
              file={subImageFile2}
              onChange={setSubImageFile2}
            />
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">
            メインは必須／サブは任意。タップで画像を選択、「カメラで撮る」で撮影。横長または正方形推奨・~5MB 目安。
          </p>
        </div>

        {/* お店からのひとこと（任意） */}
        <div className="md:col-span-2">
          <label className="block text-xs text-zinc-600 mb-1">お店からのひとこと（任意）</label>
          <textarea
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-300"
            placeholder="例）おすすめ商品です。数量限定につきお早めに！"
            rows={4}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="mt-1 text-right text-[11px] text-zinc-500">{note.length}/300</div>
        </div>


        {/* 公開タイミング（今すぐ / 予約して公開） */}
        <div className="md:col-span-2">
          <label className="block text-xs text-zinc-600 mb-1">公開</label>

          {/* ▼ PCでもSPと同じ見た目：2分割トグル風 */}
          <div className="w-full rounded-lg border border-zinc-300 overflow-hidden bg-white">
            <div className="grid grid-cols-2 divide-x divide-zinc-300">
              <label className="flex items-center justify-center gap-2 py-2 md:py-2.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="pub"
                  checked={publishMode === 'now'}
                  onChange={() => setPublishMode('now')}
                />
                <span>今すぐ公開</span>
              </label>
              <label className="flex items-center justify-center gap-2 py-2 md:py-2.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="pub"
                  checked={publishMode === 'schedule'}
                  onChange={() => setPublishMode('schedule')}
                />
                <span>予約して公開</span>
              </label>
            </div>
          </div>

          {publishMode === 'schedule' && (
            <div className="mt-2">
              <input
                type="datetime-local"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm bg-white"
                value={publishLocal}
                onChange={(e) => setPublishLocal(e.target.value)}
                step={60}
                aria-label="公開開始（ローカル）"
              />
            </div>
          )}
        </div>


        {/* 追加ボタン（フル幅・親指タップしやすく） */}
        <div className="md:col-span-2">
          <button
            className="w-full rounded-xl bg-zinc-900 text-white mt-6 mb-8 py-3 text-sm font-medium shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={
              ploading ||
              !name.trim() ||
              !price.trim() ||
              !stock.trim() ||
              pickupSlotForNew === null ||
              !mainImageFile // ★ メイン画像必須
            }
          >
            追加
          </button>
        </div>
      </form>

      {/* フォーム用：カメラ撮影モーダル（登録済みと同一コンポーネントを再利用） */}
      {formCam && (
        <CameraCaptureModal
          open={true}
          title={`${formCam.label}画像を撮影`}
          onClose={() => setFormCam(null)}
          onCapture={(blob) => {
            const file = new File([blob], "camera.jpg", { type: blob.type || "image/jpeg" });
            if (formCam.slot === "main") setMainImageFile(file);
            if (formCam.slot === "sub1") setSubImageFile1(file);
            if (formCam.slot === "sub2") setSubImageFile2(file);
            setFormCam(null);
          }}
          facing="environment"
        />
      )}


      {perr ? <div className="text-sm text-red-600">{perr}</div> : null}

      {/* ▼ ここで見出しを追加（商品が1件以上のとき） */}
      {products.length > 0 && <SectionTitle>出品中の商品</SectionTitle>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {products.map((p) => {
          return (
            <div key={p.id} className="rounded-2xl border bg-white shadow-sm overflow-hidden">
              {/* ヘッダー：商品名 + 在庫チップ（価格は下段に移動） */}
              <div className="px-4 pt-4 mb-4">
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

                    {/* 予約公開バッジ（表示のみ：既存商品の編集は不可） */}
                    {p.publish_at ? (() => {
                      const now = Date.now();
                      const ts = Date.parse(p.publish_at!);
                      const scheduled = isFinite(ts) && ts > now;
                      return (
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border
          ${scheduled ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-zinc-100 text-zinc-600 border-zinc-200'}`}
                          >
                            {scheduled ? '予約公開' : '公開済（予約）'}
                          </span>
                          <span className="text-[11px] text-zinc-500" suppressHydrationWarning>
                            {scheduled ? new Date(p.publish_at!).toLocaleString('ja-JP') : ''}
                          </span>
                        </div>
                      );
                    })() : null}


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

                  {/* 右側：価格・店側受取（ヘッダー内に配置） */}
                  <div className="shrink-0 text-right leading-tight">
                    <div className="text-xl font-bold tabular-nums">{yen(p.price)}</div>
                    <div className="text-[11px] text-zinc-500">店側受取 {yen(storeTake(p.price))}</div>
                  </div>
                </div>
              </div>

              {/* 操作UI（価格 → 受け取り時間 → ボタン2列） */}
              <div className="px-4 pb-4 space-y-3">

                {/* 1) 価格は右寄せ・独立行（はみ出し対策） */}

                {/* 2) 受け取り時間（表示 + 変更ボタン → モーダルで編集） */}
                <div>
                  <div className="text-sm font-medium mb-1">受け取り時間</div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-zinc-800">{labelForSlot(p.pickup_slot_no)}</div>
                    {/* <button
                      className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
                      onClick={() => setPickupDlg({ id: p.id, name: p.name, current: p.pickup_slot_no ?? 1 })}
                    >
                      変更
                    </button> */}
                  </div>
                </div>

                {/* ひとこと（表示＋編集） */}
                <div className="pt-1">
                  <div className="text-sm font-medium mb-1">お店からのひとこと</div>

                  {/* 表示部（常に数行だけ・全文は編集モーダルで開く） */}
                  <div
                    className="text-sm text-zinc-700 bg-zinc-50 rounded-xl p-3 line-clamp-2"
                    title={p.note ?? undefined}
                  >
                    {(p.note && p.note.trim().length > 0)
                      ? p.note
                      : 'お店のおすすめ商品です。数量限定のため、お早めにお求めください。'}
                  </div>


                  {/* 編集トグル（店側UI）：タップで編集欄を開閉 */}
                  {/* <div className="mt-2 text-right">
                    <button
                      type="button"
                      className="rounded-xl border px-3 py-1.5 text-sm hover:bg-zinc-50"
                      onClick={() => {
                        setNoteDlg({
                          id: p.id,
                          name: p.name,
                          note: String(p.note ?? "").slice(0, 300),
                        });
                      }}
                    >
                      編集（全文表示）
                    </button>
                  </div> */}
                </div>


                {/* 3) 在庫調整 / 削除（横並び） */}
                {/* <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setAdjust({ id: p.id, name: p.name, stock: p.stock })}
                    className="w-full px-3 py-2 rounded-xl border text-sm hover:bg-zinc-50"
                  >
                    在庫調整
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm(`「${p.name}」を削除しますか？`)) return;
                      try { await remove(p.id); } catch (e: any) { alert(`削除に失敗しました: ${e?.message ?? e}`); }
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-red-50 text-red-600 text-sm hover:bg-red-100"
                  >
                    商品削除
                  </button>
                </div> */}
              </div>


              {/* 3枚サムネ（メイン/サブ1/サブ2）— スマホで列幅にフィット */}
              <div className="px-4 py-3">
                <div className="grid grid-cols-3 gap-2">
                  <ProductImageSlot
                    mode="existing"
                    productId={p.id}
                    slot="main"
                    label="メイン"
                    path={p.main_image_path}
                    imgVer={imgVer}
                    onReload={reload}
                    readonly
                  />
                  <ProductImageSlot
                    mode="existing"
                    productId={p.id}
                    slot="sub1"
                    label="サブ1"
                    path={p.sub_image_path1}
                    imgVer={imgVer}
                    onReload={reload}
                    readonly
                  />
                  <ProductImageSlot
                    mode="existing"
                    productId={p.id}
                    slot="sub2"
                    label="サブ2"
                    path={p.sub_image_path2}
                    imgVer={imgVer}
                    onReload={reload}
                    readonly
                  />
                </div>
              </div>

              {/* 一括編集（モーダル） + 商品削除 */}
              <div className="mt-4 mb-8 flex flex-col items-center gap-2">
                <button
                  onClick={() => setEditDlg(p)}
                  className="px-4 py-2 rounded-xl border text-sm bg-white hover:bg-zinc-50
               w-[min(90%)]"
                >
                  内容を変更する
                </button>

                <button
                  onClick={async () => {
                    if (!confirm('本当に削除しますか？')) return;
                    try {
                      await remove(p.id);
                    } catch (e: any) {
                      alert(`削除に失敗しました: ${e?.message ?? e}`);
                    }
                  }}
                  className="px-4 py-2 rounded-xl border text-sm
               text-red-600 border-red-300 bg-red-50 hover:bg-red-100
               w-[min(90%)]"
                >
                  商品を削除する
                </button>
              </div>

            </div>
          );
        })}
      </div>

      {/* ▼ 軽量トースト：下部にふわっと表示 */}
      {toastMsg && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] px-3 py-2 rounded-full text-[12px] bg-zinc-900 text-white shadow-lg">
          {toastMsg}
        </div>
      )}

      {/* カメラ撮影モーダル */}
      {cam && (
        <CameraCaptureModal
          open={true}
          title={`${cam.label}画像を撮影`}
          onClose={() => setCam(null)}
          onCapture={async (blob) => {
            try {
              const file = new File([blob], "camera.jpg", { type: blob.type || "image/jpeg" });
              setUploadingId(cam.productId);
              await uploadProductImage(cam.productId, file, cam.slot);
              await reload();
              setImgVer(v => v + 1);
              alert(`${cam.label}画像を更新しました`);
            } catch (e: any) {
              alert(`アップロードに失敗しました: ${e?.message ?? e}`);
            } finally {
              setUploadingId(null);
              setCam(null);
            }
          }}
          facing="environment"
        />
      )}

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
      {/* ▼ 受け取り時間 変更モーダル */}
      <PickupSlotModal
        open={!!pickupDlg}
        productName={pickupDlg?.name ?? ""}
        initial={pickupDlg?.current ?? 1}
        presets={presets}
        disabled={ploading}
        onClose={() => setPickupDlg(null)}
        onCommit={async (val) => {
          if (!pickupDlg) return;
          await updatePickupSlot(pickupDlg.id, val);
          setPickupDlg(null);
        }}
      />

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

      {/* ひとこと編集モーダル */}
      <NoteEditModal
        open={!!noteDlg}
        productName={noteDlg?.name ?? ""}
        initial={noteDlg?.note ?? ""}
        disabled={ploading}
        onClose={() => setNoteDlg(null)}
        onCommit={async (next) => {
          if (!noteDlg) return;
          await updateNote(noteDlg.id, next);
          setNoteDlg(null);
          alert('「ひとこと」を更新しました');
        }}
      />
      {/* 登録済み商品のフル編集モーダル */}
      {editDlg && (
        <EditProductModal
          open={true}
          product={editDlg}
          presets={presets}
          disabled={ploading}
          onClose={() => setEditDlg(null)}
          onCommit={async (patch) => {
            await updateProduct(editDlg.id, patch);
            setEditDlg(null);
            alert('商品内容を更新しました');
          }}
        />
      )}

    </div>
  )
}


// JSTの現在時刻を「その日の分(0..1440)」で返す
function nowMinutesJST(): number {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const hh = Number(parts.find(p => p.type === 'hour')?.value || '0');
  const mm = Number(parts.find(p => p.type === 'minute')?.value || '0');
  return hh * 60 + mm;
}

// "HH:MM" / "HH:MM:SS" を分に
function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(n => Number(n) || 0);
  return h * 60 + m;
}

// 日跨ぎ対応の区間内判定
function inWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;        // 0長区間は許可しない
  if (startMin < endMin) return startMin <= nowMin && nowMin <= endMin;
  // 例: 22:00-02:00
  return nowMin >= startMin || nowMin <= endMin;
}

// 各商品のプリセット時間で「全商品OKか」を判定（intersection）
function canPickupNowByPresets(
  items: OrderItem[],
  presets: Record<1 | 2 | 3, { name: string; start: string; end: string }>
): boolean {
  // 商品が参照する有効なスロットだけ集める（1..3）
  const slots = Array.from(
    new Set(
      (items || [])
        .map(it => (it as any)?.pickup_slot_no) // itemsに入っていない場合は後段で再取得してもOK
        .filter((n: any) => typeof n === 'number' && n >= 1 && n <= 3)
    )
  ) as Array<1 | 2 | 3>;

  // items からスロットが取れない実装の場合：
  // → すでに本ファイルでは OrderCard で products を読みにいっているため、
  //   必要ならそこで items に {id, qty, pickup_slot_no} を持たせるよう拡張してもOK。

  // スロットが一つも無ければ＝制約なし → 許可
  if (slots.length === 0) return true;

  // どれかのプリセットが欠けていたら安全側でNG
  for (const s of slots) {
    if (!presets[s] || !presets[s].start || !presets[s].end) return false;
  }

  const now = nowMinutesJST();
  // 「全てのスロットの区間に“今”が入っている」→ 許可（＝積）
  return slots.every((s) => {
    const st = toMinutes(presets[s].start);
    const en = toMinutes(presets[s].end);
    return inWindow(now, st, en);
  });
}



function OrdersPage() {
  const { presets } = usePickupPresets(); // 既存
  const supabase = useSupabase();         // ← 追加
  const { ready, err, pending, fulfilled, fulfill, requestRedeem, clearPending, clearFulfilled, retry } = useOrders();
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
  const [overrideAsk, setOverrideAsk] = useState(false);
  // 各商品の pickup_slot_no から “店舗受取可能時間” で可否判定
  const isWithinStorePresetForOrder = useCallback(async (o: Order) => {
    if (!supabase) return true; // 取得できなければ落とさない
    const ids = Array.from(new Set((o.items || []).map(it => String(it.id || '')).filter(Boolean)));
    if (ids.length === 0) return true;  // 制約なし
    const { data: prows } = await (supabase as any)
      .from('products')
      .select('id,pickup_slot_no')
      .in('id', ids);
    const slots = Array.from(new Set(
      (prows || []).map((r: any) => r?.pickup_slot_no).filter((n: any) => typeof n === 'number' && n >= 1 && n <= 3)
    )) as Array<1 | 2 | 3>;
    if (slots.length === 0) return true; // 制約なし
    // プリセットが欠けていれば安全側でNG
    if (slots.some(s => !presets[s]?.start || !presets[s]?.end)) return false;
    const now = nowMinutesJST();
    return slots.every((s) => {
      const st = toMinutes(presets[s].start);
      const en = toMinutes(presets[s].end);
      return inWindow(now, st, en);
    });
  }, [supabase, presets]);


  return (
    <main className="mx-auto max-w-[448px] md:max-w-4xl lg:max-w-6xl px-4 py-5 space-y-6">
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{pending.map(o => (<OrderCard key={o.id} order={o} onHandoff={setCurrent} onRequestRedeem={requestRedeem} />))}</div>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-90">{fulfilled.map(o => (<OrderCard key={o.id} order={o} onHandoff={() => { }} onRequestRedeem={() => { }} />))}</div>
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
            {/* ▼ 時間外オーバーライド確認（表示中は上に確認ボックスを出す） */}
            {overrideAsk && (
              <div className="mb-3 rounded-xl border p-3 bg-amber-50 text-amber-800">
                <div className="text-sm font-semibold mb-1">確認</div>
                <p className="text-sm leading-relaxed">
                  受取時間外ですが、<b>店舗の裁量で受け渡しを完了</b>します。よろしいですか？
                </p>
                <ul className="mt-2 text-xs text-amber-800/90 list-disc pl-5 space-y-1">
                  <li>注文ID: {current?.id}</li>
                  <li>顧客: {current?.customer}</li>
                  <li>照合コード: •••••{expectedCode?.slice(-1) || '—'}</li>
                </ul>
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg border px-3 py-1.5 text-sm bg-white"
                    onClick={() => setOverrideAsk(false)}
                  >戻る</button>
                  <button
                    type="button"
                    className="rounded-lg px-3 py-1.5 text-sm text-white bg-zinc-900"
                    onClick={() => {
                      const raw = String(codeInput ?? '').replace(/\D/g, '');
                      if (!expectedCode || expectedCode.length !== 6) { setCodeErr('この注文にはコードが登録されていません'); return; }
                      if (!storeOk) { setCodeErr('店舗が一致しません'); return; }
                      if (raw.length !== 6) { setCodeErr('6桁のコードを入力してください'); return; }
                      if (raw !== expectedCode) { setCodeErr('コードが一致しません'); return; }
                      // ★ オーバーライドで実行
                      fulfill(current!.id, { override: true });
                      setCurrent(null); setCodeInput(""); setCodeErr(null); setOverrideAsk(false);
                    }}
                  >許可して受け渡す</button>
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <button onClick={() => setCurrent(null)} className="rounded-xl border px-4 py-2 text-sm">キャンセル</button>
              <div className="flex items-center gap-2">
                {/* 通常の受け渡し */}
                <button
                  onClick={async () => {
                    const raw = String(codeInput ?? '').replace(/\D/g, '');
                    if (!expectedCode || expectedCode.length !== 6) { setCodeErr('この注文にはコードが登録されていません'); return; }
                    if (!storeOk) { setCodeErr('店舗が一致しません'); return; }
                    if (raw.length !== 6) { setCodeErr('6桁のコードを入力してください'); return; }
                    if (raw !== expectedCode) { setCodeErr('コードが一致しません'); return; }

                    const okByPreset = await isWithinStorePresetForOrder(current!);
                    if (!okByPreset) {
                      setOverrideAsk(true); // 時間外 → 確認ダイアログへ
                      return;
                    }

                    // 時間内 → 通常受取を実行
                    requestRedeem(current!.id);
                    setCurrent(null); setCodeInput(""); setCodeErr(null);
                  }}

                  className={`rounded-xl px-4 py-2 text-sm text-white ${canFulfill ? 'bg-zinc-900' : 'bg-zinc-400 cursor-not-allowed'}`}
                  disabled={!canFulfill}
                >受け渡し</button>

                {/* 店舗裁量ボタン：押すと上の確認ボックスを展開 */}
                <button
                  type="button"
                  onClick={() => setOverrideAsk(true)}
                  className={`rounded-xl px-3 py-2 text-sm border bg-white hover:bg-zinc-50 ${canFulfill ? '' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={!canFulfill}
                  title="受取時間外でも店舗裁量で受け渡し"
                >
                  時間外でも受け渡す
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {scanOpen && (
        <ScanChooser
          onDetect={(raw) => { setCodeInput(raw); setCodeErr(null); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}

    </main>
  );
}

function ProductsPage() {
  return (
    <main className="mx-auto max-w-[448px] lg:max-w-6xl px-4 py-5 space-y-8">
      <ProductForm />
      <div className="text-xs text-zinc-500">※ 商品管理は単一ページとして暫定運用。ブックマーク例: <code>#/products</code></div>
    </main>
  );
}

// === 受取時間プリセット設定（店側） =====================================
function PickupPresetPage() {
  // 認証を確保（未ログイン時は匿名サインインを試行 or 何もしない設定）
  useEnsureAuth();
  const supabase = (() => {
    // 既存 useSupabase と同等のクライアントを取る（window.__supabase 優先）
    const w = typeof window !== 'undefined' ? (window as any) : null;
    if (w?.__supabase) return w.__supabase;
    const url = w?.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = w?.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    return createClient<any>(url, key, { global: { headers: { 'x-store-id': String(getStoreId() || '') } } });
  })();


  type SlotNo = 1 | 2 | 3;
  type PresetRow = {
    slot_no: SlotNo;
    name: string;
    start_time: string;    // "HH:MM:SS"
    end_time: string;      // "HH:MM:SS"
    slot_minutes: number;  // 10固定
  };

  const SLOT_NUMBERS: SlotNo[] = [1, 2, 3];
  const hhmm = (t: string) => t.slice(0, 5);
  const hhmmss = (t: string) => (t.length === 5 ? `${t}:00` : t);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [current, setCurrent] = useState<SlotNo | null>(1);
  const [rows, setRows] = useState<Record<SlotNo, PresetRow>>({
    1: { slot_no: 1, name: "通常", start_time: "10:00:00", end_time: "14:00:00", slot_minutes: 10 },
    2: { slot_no: 2, name: "短縮1", start_time: "16:00:00", end_time: "20:00:00", slot_minutes: 10 },
    3: { slot_no: 3, name: "短縮2", start_time: "18:00:00", end_time: "22:00:00", slot_minutes: 10 },
  });

  // 初期読み込み
  useEffect(() => {
    (async () => {
      if (!supabase) return;
      setLoading(true);
      setMsg(null);

      // 認証チェック（未ログインなら中断）
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) {
        setMsg('ログインが必要です。ログイン後に再度お試しください。');
        setLoading(false);
        return;
      }

      // 現在のスロット番号
      const { getMyStoreId } = await import("@/lib/getMyStoreId");
      const myStoreId = await getMyStoreId();
      const { data: store } = await (supabase as any)
        .from('stores')
        .select('id,current_pickup_slot_no')
        .eq('id', myStoreId)
        .single();
      // any 経由で never 回避
      const cur = (((store as any)?.current_pickup_slot_no) ?? 1) as SlotNo;

      setCurrent(cur);

      // 既存プリセット
      const { data: presets } = await supabase
        .from('store_pickup_presets')
        .select('slot_no,name,start_time,end_time,slot_minutes')
        .eq('store_id', myStoreId)
        .order('slot_no', { ascending: true });

      if (presets && presets.length) {
        const m = { ...rows };
        for (const p of presets as PresetRow[]) {
          m[p.slot_no] = {
            slot_no: p.slot_no,
            name: p.name ?? '',
            start_time: p.start_time ?? '10:00:00',
            end_time: p.end_time ?? '14:00:00',
            slot_minutes: Number(p.slot_minutes ?? 10),
          };
        }
        setRows(m);
      }

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRow = (slot: SlotNo, patch: Partial<PresetRow>) => {
    setRows(prev => ({ ...prev, [slot]: { ...prev[slot], ...patch } }));
  };

  const errors = useMemo(() => {
    const list: string[] = [];
    for (const s of SLOT_NUMBERS) {
      const r = rows[s];
      if (!r.name.trim()) list.push(`プリセット${s}: 名称を入力してください`);
      if (hhmm(r.start_time) >= hhmm(r.end_time)) list.push(`プリセット${s}: 開始は終了より前にしてください`);
    }
    return list;
  }, [rows]);

  const save = async () => {
    if (!supabase) return;
    setMsg(null);
    if (errors.length) { setMsg(errors[0]); return; }
    setSaving(true);
    try {
      // 3枠まとめて UPSERT（store_id も明示）※ onConflict は「store_id,slot_no」
      const { getMyStoreId: _getMyStoreId2 } = await import("@/lib/getMyStoreId");
      const myStoreId2 = await _getMyStoreId2();
      // API 経由の保存（LIFFサイン）。RLS不達でも service_role で吸収
      const { upsertPickupPresets } = await import("@/lib/pickupPresets");
      const presets = SLOT_NUMBERS.map((s) => ({
        slot_no: rows[s].slot_no,
        name: rows[s].name.trim(),
        start_time: hhmmss(hhmm(rows[s].start_time)),
        end_time: hhmmss(hhmm(rows[s].end_time)),
        slot_minutes: 10,
      }));
      await upsertPickupPresets(presets);

      // 旧: SDK 直 upsert は無効化
      if (true) {
        const payload = SLOT_NUMBERS.map((s) => ({
          // TODO(req v2): store_id は固定値禁止。常にログインユーザーの店舗IDを使用
          store_id: myStoreId2,
          slot_no: rows[s].slot_no,
          name: rows[s].name.trim(),
          start_time: hhmmss(hhmm(rows[s].start_time)),
          end_time: hhmmss(hhmm(rows[s].end_time)),
          slot_minutes: 10,
        }));
        // サーバーAPI経由で保存（service_role, onConflict: store_id,slot_no）
        try {
          const resp = await fetch('/api/store/pickup-presets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ rows: payload, current_slot_no: current ?? undefined }),
          });
          if (!resp.ok) {
            const j = await resp.json().catch(() => ({} as any));
            throw new Error(j?.error || `API ${resp.status}`);
          }
          setMsg('保存しました。ユーザーアプリに反映されます。');
          return;
        } catch (e) {
          throw e;
        }
        // any 経由で never 回避
        const up = await (supabase as any)
          .from('store_pickup_presets')
          .upsert(payload, { onConflict: 'store_id,slot_no' });

        if (up.error) throw up.error;
      }

      // “今使う”スロットを stores に反映
      if (current) {
        const { getMyStoreId: _getMyStoreId3 } = await import("@/lib/getMyStoreId");
        const myStoreId3 = await _getMyStoreId3();
        const st = await (supabase as any)
          .from('stores')
          .update({ current_pickup_slot_no: current })
          .eq('id', myStoreId3);

        if (st.error) throw st.error;
      }

      setMsg('保存しました。ユーザーアプリに即時反映されます。');
    } catch (e: any) {
      setMsg(`保存に失敗しました: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <main className="mx-auto max-w-[448px] lg:max-w-6xl px-4 py-5"><div className="rounded-xl border bg-white p-4 text-sm text-zinc-600">読み込み中…</div></main>;

  return (
    <main className="mx-auto max-w-[448px] lg:max-w-6xl px-4 py-5 space-y-6">
      <div className="mb-1">
        <h1 className="text-lg font-semibold">受取時間プリセット設定</h1>
        <p className="text-sm text-zinc-600">最大3つのプリセットを編集し、「今使う」を選択してください（10分刻み）。</p>
      </div>

      <section className="space-y-4">
        {[1, 2, 3].map((slot) => {
          const r = rows[slot as SlotNo];
          return (
            <div key={slot} className="rounded-2xl border bg-white p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">プリセット {slot}</div>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="current"
                    checked={current === slot}
                    onChange={() => setCurrent(slot as SlotNo)}
                  />
                  今使う
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">名称</label>
                  <input
                    className="w-full rounded-xl border px-3 py-2"
                    maxLength={20}
                    placeholder={`通常 / 短縮${slot - 1} など`}
                    value={r.name}
                    onChange={(e) => setRow(slot as SlotNo, { name: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">開始</label>
                  <input
                    type="time"
                    step={600}
                    className="w-full rounded-xl border px-3 py-2"
                    value={hhmm(r.start_time)}
                    onChange={(e) => setRow(slot as SlotNo, { start_time: hhmmss(e.target.value) })}
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">終了</label>
                  <input
                    type="time"
                    step={600}
                    className="w-full rounded-xl border px-3 py-2"
                    value={hhmm(r.end_time)}
                    onChange={(e) => setRow(slot as SlotNo, { end_time: hhmmss(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {msg && <div className="text-sm text-zinc-700">{msg}</div>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className={`px-4 py-2 rounded-2xl text-white ${saving ? 'bg-zinc-400' : 'bg-zinc-900 hover:bg-zinc-800'}`}
        >
          {saving ? '保存中…' : '保存する'}
        </button>
      </div>
    </main>
  );
}



export default function StoreApp() {
  const mounted = useMounted();
  const [route, setRoute] = useState<'orders' | 'products' | 'pickup'>('orders');

  useEffect(() => {
    const read = () => {
      const h = (typeof window !== 'undefined' ? window.location.hash.replace('#/', '') : '') as 'orders' | 'products' | 'pickup';
      setRoute(h === 'products' ? 'products' : h === 'pickup' ? 'pickup' : 'orders');
    };

    read(); window.addEventListener('hashchange', read); return () => window.removeEventListener('hashchange', read);
  }, []);

  // --- 追加：ログアウト処理 ---
  const logout = React.useCallback(async () => {
    try {
      // 1) クライアント側の選択情報などを掃除
      try { localStorage.removeItem('store:selected'); } catch { }
      try { (window as any).__STORE_ID__ = ""; } catch { }

      // 2) サーバCookie（store_session）を無効化
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => { });

      // 3) ログイン画面へ
      location.href = "/login";
    } catch {
      // 失敗しても最後はログインへ逃す
      location.href = "/login";
    }
  }, []);

  const routeForUI = mounted ? route : 'orders';

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 border-b">
        <div className="mx-auto max-w-[448px] lg:max-w-6xl px-4 py-3 flex items-center justify-between gap-2">
          {/* 左：ナビ */}
          <nav className="flex flex-wrap items-center gap-1 gap-y-1 text-sm">
            <a
              href="#/orders"
              className={`px-3 py-1.5 rounded-lg border shrink-0 ${routeForUI === 'orders' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`}
              suppressHydrationWarning
            >
              注文管理
            </a>
            <a
              href="#/products"
              className={`px-3 py-1.5 rounded-lg border shrink-0 ${routeForUI === 'products' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`}
              suppressHydrationWarning
            >
              商品管理
            </a>
            <a
              href="#/pickup"
              className={`px-3 py-1.5 rounded-lg border shrink-0 ${routeForUI === 'pickup' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50'}`}
              suppressHydrationWarning
            >
              受取時間
            </a>
            <a
              href="/analytics"
              className="px-3 py-1.5 rounded-lg border shrink-0 bg-white text-zinc-700 hover:bg-zinc-50"
            >
              売上・分析
            </a>
          </nav>

          {/* 右：ログアウト */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={logout}
              className="px-3 py-1.5 rounded-lg border shrink-0 bg-white text-zinc-700 hover:bg-zinc-50 mr-5"
              title="ログアウト"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {routeForUI === 'orders' ? <OrdersPage /> : routeForUI === 'products' ? <ProductsPage /> : <PickupPresetPage />}
    </div>
  );
}
