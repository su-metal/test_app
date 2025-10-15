'use client';
/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element, jsx-a11y/alt-text */

import React, { useMemo, useState, useEffect, createContext, useContext, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Clock, Star, Search, BadgePercent, ShoppingBag, X, Bell, History, Heart, ChevronRight, CreditCard, Smartphone, ArrowLeft, Plus, Minus, Check } from "lucide-react";
import type { Store, Offer } from "@/lib/types";
import HomeCartBanner from "@/components/banner/HomeCartBanner";
import Tabbar from "@/components/nav/Tabbar";
import Header from "@/components/layout/Header";
import { useToast } from "@/components/ui/use-toast";
import { firstStoreWithItems, resolveStoreName } from "@/lib/cart-helpers";
// エイリアスが使える場合（推奨）
import { Card, Button } from "@/ui";
import { fallbackImage, type FallbackKind } from "@/lib/fallbackImage";

type Route = { name: "home" | "store" | "product" | "checkout" | "orders"; params: any };
type NavHistory = {
  current: Route;
  push: (r: Route) => void;
  replace: (r: Route) => void;
  pop: () => void;
  reset: (r?: Route) => void; // default: home
};

// 「Checkout → Orders → Back でホームへ」の一度きり判定用
const lastFlowRefGlobal: { value: "checkoutToOrders" | null } = { value: null };

function useNavStack(initial: Route = { name: "home", params: {} }): NavHistory {
  const [stack, setStack] = React.useState<Route[]>([initial]);

  const current = stack[stack.length - 1];

  const push = (r: Route) => {
    setStack((s) => [...s, r]);
    // 画面遷移時は常にトップへ
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const replace = (r: Route) => {
    setStack((s) => (s.length ? [...s.slice(0, -1), r] : [r]));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const pop = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const reset = (r: Route = { name: "home", params: {} }) => {
    setStack([r]);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  return { current, push, replace, pop, reset };
}

// ←もし「モジュールが見つかりません」と出たら、代わりにこれ（app/page.tsx から見た相対パス）
/* import { Card, Button } from "../src/ui"; */

// SVGダミー（dummyImage）や空文字なら true
const isDummyImg = (src?: string | null) => !src || src.startsWith("data:image/svg+xml");

// ダミー/未設定なら fallbackImage に強制置換
const imgOrFallback = (
  kind: FallbackKind,
  src?: string | null,
  seed?: string,
  w?: number
) => (isDummyImg(src) ? fallbackImage(kind, seed, w) : (src as string));


// ダミー画像（SVG）の data URI を生成
function dummyImage(label: string, bg = "#10b981") {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>
       <defs>
         <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
           <stop offset='0%' stop-color='${bg}'/>
           <stop offset='100%' stop-color='#ffffff'/>
         </linearGradient>
       </defs>
       <rect width='100%' height='100%' fill='url(#g)'/>
       <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
             font-family='system-ui, -apple-system, Segoe UI, Roboto' font-size='36'
             fill='rgba(0,0,0,.55)' font-weight='700'>${label}</text>
     </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}


// ---- design tokens ----
const brand = { bg: "bg-gradient-to-b from-emerald-50 via-white to-white", card: "bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60", ring: "focus:ring-2 focus:ring-emerald-500/40 focus:outline-none" };
// ===== Shared width/size tokens for checkout bar & home cart banner =====
export const BAR_CONTAINER_CLASS = "max-w-md mx-auto px-4";
export const BAR_OUTER_CLASS = "flex items-center justify-between gap-3 rounded-2xl bg-emerald-600 text-white shadow " +
  "px-4 py-3 min-h-[64px]";
export const BAR_BTN_CLASS = `h-9 px-4 rounded-xl bg-white text-emerald-700 text-sm font-semibold hover:bg-emerald-50 active:scale-[0.98] transition ${brand.ring}`;
// 共通：カート系の「白ボタン（黒字）」スタイル
const CART_BTN_CLASS =
  "!h-10 !px-4 !rounded-[32px] !whitespace-nowrap " + // サイズ＆角丸（= HomeCart と統一）
  "!bg-white !text-zinc-900 !border-0 shadow-sm " +   // 配色（白/黒・薄い影）
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
const STORE_CART_BAR_CLASS =
  "w-[92%] mx-auto rounded-[32px] text-white shadow-xl ring-1 ring-white/10 " +
  "bg-gradient-to-br from-zinc-800 via-zinc-900 to-black " +
  "px-4 py-3 min-h-[64px] flex items-center justify-between gap-4";

// ---- lightweight components (added) ----
function Hero() {
  return (
    <div className={`rounded-3xl border ${brand.card} p-5 flex items-center gap-3`}>
      <div className="flex-1">
        <div className="text-sm text-emerald-700 font-semibold">フードロスを減らそう</div>
        <div className="text-xs text-gray-600">近くのお店の余剰品をおトクに予約できます</div>
      </div>
      <div className="rounded-2xl bg-emerald-600 text-white text-xs px-3 py-2 shadow">今日の特価</div>
    </div>
  );
}

function SearchBar({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-2xl border bg-white/90 shadow ${brand.ring}`}>
      <Search className="w-4 h-4 text-gray-500" />
      <input
        value={query}
        onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
        placeholder="キーワード検索"
        className="w-full bg-transparent text-sm focus:outline-none"
      />
      {query && (
        <button className="text-xs px-2 py-1 rounded-xl border" onClick={() => setQuery("")}>
          クリア
        </button>
      )}
    </div>
  );
}



function useCartActions(
  cart: Record<string, Record<string, number>>,
  setCart: React.Dispatch<React.SetStateAction<Record<string, Record<string, number>>>>,
  storesList?: any[],
  offersList?: any[]
) {
  const { toast } = useToast();

  const ensureSingleStoreAndSet = (sid: string, offerId: string, nextQty: number) => {
    const sanitizedQty = Math.max(0, nextQty ?? 0);
    const currentSid = firstStoreWithItems(cart);
    const isDifferentStore = sanitizedQty > 0 && currentSid && currentSid !== sid;

    if (isDifferentStore) {
      setCart({
        [sid]: { [offerId]: sanitizedQty },
      });
      const name = resolveStoreName(sid, storesList, offersList);
      toast({
        title: "カートを店舗ごとに切り替えました",
        description: `${name} の商品が追加されたため、他店舗の商品をクリアしました。`,
      });
      return;
    }

    setCart((prev) => {
      const next = { ...(prev || {}) } as Record<string, Record<string, number>>;
      const storeEntry = { ...(next[sid] || {}) } as Record<string, number>;

      // 0 でも行を残したいので削除しない
      storeEntry[offerId] = sanitizedQty; // ← 0〜max をそのまま格納

      // 店舗配下にも最低1件キーを残す（全部 0 でもOK）
      next[sid] = storeEntry;


      if (Object.keys(storeEntry).length > 0) {
        next[sid] = storeEntry;
      } else {
        delete next[sid];
      }

      return next;
    });
  };

  const setQty = (sid: string, offerId: string, qty: number) => {
    ensureSingleStoreAndSet(sid, offerId, qty);
  };

  const addToCart = (sid: string, offerId: string) => {
    const current = cart?.[sid]?.[offerId] ?? 0;
    ensureSingleStoreAndSet(sid, offerId, current + 1);
  };

  return { addToCart, setQty };
}

// ---- data (shortened to avoid size limits) ----
const stores: Store[] = [
  { id: "s1", name: "グリーンベーカリー", distanceKm: 0.4, rating: 4.6, tags: ["ベーカリー", "ヴィーガン対応"], address: "港区芝公園 1-2-3" },
  { id: "s2", name: "和ごころ惣菜", distanceKm: 1.1, rating: 4.4, tags: ["惣菜", "和食"], address: "港区三田 2-4-6" },
  { id: "s3", name: "Sunny Super", distanceKm: 0.9, rating: 4.2, tags: ["スーパー", "アレルゲン表示"], address: "港区虎ノ門 3-5-7" },
];
// ---- data (dummy offers: 5 items per store) ----
// 1) 追加：ダミー画像を生成するヘルパー
// function dummyImage(label: string, bg = "#10b981") {
//   const svg =
//     `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>
//        <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
//          <stop offset='0%' stop-color='${bg}'/><stop offset='100%' stop-color='#ffffff'/>
//        </linearGradient></defs>
//        <rect width='100%' height='100%' fill='url(#g)'/>
//        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
//          font-family='system-ui, -apple-system, Segoe UI, Roboto' font-size='36'
//          fill='rgba(0,0,0,.55)' font-weight='700'>${label}</text>
//      </svg>`;
//   return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
// }

// 2) 置換：offers を丸ごと差し替え（各項目をフル指定）
const offers: Offer[] = [
  // s1: グリーンベーカリー
  { id: "o1", storeId: "s1", name: "お楽しみパンBOX（3点）", originalPrice: 980, price: 490, discount: 50, pickup: "本日 18:00-20:00", left: 4, allergens: ["小麦", "乳"], img: dummyImage("BAKERY 1", "#34d399") },
  { id: "o4", storeId: "s1", name: "焼き立てクロワッサン（2個）", originalPrice: 520, price: 300, discount: 42, pickup: "本日 18:00-20:00", left: 3, allergens: ["小麦", "乳"], img: dummyImage("BAKERY 2", "#34d399") },
  { id: "o5", storeId: "s1", name: "バゲット（規格外）", originalPrice: 380, price: 220, discount: 42, pickup: "本日 17:30-19:30", left: 5, allergens: ["小麦"], img: dummyImage("BAKERY 3", "#34d399") },
  { id: "o6", storeId: "s1", name: "シナモンロール", originalPrice: 420, price: 260, discount: 38, pickup: "本日 18:30-20:00", left: 2, allergens: ["小麦", "乳"], img: dummyImage("BAKERY 4", "#34d399") },
  { id: "o7", storeId: "s1", name: "デニッシュ詰め合わせ", originalPrice: 780, price: 480, discount: 38, pickup: "本日 19:00-20:30", left: 4, allergens: ["小麦", "乳"], img: dummyImage("BAKERY 5", "#34d399") },

  // s2: 和ごころ惣菜
  { id: "o2", storeId: "s2", name: "日替わり惣菜パック（2人前）", originalPrice: 1200, price: 720, discount: 40, pickup: "本日 19:00-21:00", left: 2, allergens: ["大豆", "小麦"], img: dummyImage("DELI 1", "#f59e0b") },
  { id: "o8", storeId: "s2", name: "唐揚げ&南蛮セット", originalPrice: 980, price: 590, discount: 40, pickup: "本日 18:30-20:30", left: 3, allergens: ["小麦"], img: dummyImage("DELI 2", "#f59e0b") },
  { id: "o9", storeId: "s2", name: "出汁巻き玉子（大）", originalPrice: 560, price: 340, discount: 39, pickup: "本日 18:00-20:00", left: 5, allergens: ["卵", "大豆"], img: dummyImage("DELI 3", "#f59e0b") },
  { id: "o10", storeId: "s2", name: "肉じゃが（家庭の味）", originalPrice: 680, price: 410, discount: 39, pickup: "本日 19:30-21:00", left: 4, allergens: [], img: dummyImage("DELI 4", "#f59e0b") },
  { id: "o11", storeId: "s2", name: "ひじき煮", originalPrice: 420, price: 250, discount: 40, pickup: "本日 18:00-20:00", left: 5, allergens: ["大豆"], img: dummyImage("DELI 5", "#f59e0b") },

  // s3: Sunny Super
  { id: "o3", storeId: "s3", name: "野菜詰合せ（規格外）", originalPrice: 800, price: 480, discount: 40, pickup: "本日 17:30-19:00", left: 8, allergens: [], img: dummyImage("GROCERY 1", "#3b82f6") },
  { id: "o12", storeId: "s3", name: "果物お楽しみBOX", originalPrice: 1000, price: 600, discount: 40, pickup: "本日 18:00-20:00", left: 6, allergens: [], img: dummyImage("GROCERY 2", "#3b82f6") },
  { id: "o13", storeId: "s3", name: "サラダミックス（大）", originalPrice: 480, price: 290, discount: 39, pickup: "本日 17:30-19:30", left: 7, allergens: [], img: dummyImage("GROCERY 3", "#3b82f6") },
  { id: "o14", storeId: "s3", name: "牛乳（賞味迫り・2本）", originalPrice: 380, price: 220, discount: 42, pickup: "本日 18:30-20:30", left: 5, allergens: ["乳"], img: dummyImage("GROCERY 4", "#3b82f6") },
  { id: "o15", storeId: "s3", name: "パン耳＆ラスクセット", originalPrice: 420, price: 250, discount: 40, pickup: "本日 19:00-21:00", left: 6, allergens: ["小麦"], img: dummyImage("GROCERY 5", "#3b82f6") },
];



// ---- helpers (defined BEFORE any usage to avoid TDZ) ----
function getStore(id: string) {
  return stores.find((s) => s.id === id) || stores[0];
}
const currency = (n: number) => n.toLocaleString("ja-JP", { style: "currency", currency: "JPY" });
const leftBadgeClass = (n: number) => (n <= 2 ? "bg-red-50 text-red-700" : n <= 5 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700");
const storeItems = (id: string, limit = 5): Offer[] =>
  offers.filter((o) => o.storeId === id).slice(0, limit);

// ---- context ----
const NavCtx = createContext<{ tab: string; setTab: (t: string) => void }>({ tab: "home", setTab: () => { } });
const useNav = () => useContext(NavCtx);

// ---- App ----
export default function App() {
  const [tab, setTab] = useState("home");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [checkoutItem, setCheckoutItem] = useState<any>(null);
  const [ticket, setTicket] = useState<any>(null);
  const [locationStatus, setLocationStatus] = useState("unknown");
  const [radiusKm, setRadiusKm] = useState(2);
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [cart, setCart] = useState<Record<string, Record<string, number>>>({});
  const cartQty = (sid: string, oid: string) => cart[sid]?.[oid] || 0;
  const { setQty: applyQty } = useCartActions(cart, setCart, stores, offers);
  const setQty = (sid: string, oid: string, qty: number, max: number) => {
    const clamped = Math.max(0, Math.min(qty, max));
    applyQty(sid, oid, clamped);
  };
  const nav = useNavStack({ name: "home", params: {} });
  const route = nav.current;

  // 追加: カート合計点数（全店舗合算）
  const totalCartQty = useMemo(() => {
    return Object.values(cart).flatMap((rec) => Object.values(rec)).reduce((a, b) => a + b, 0);
  }, [cart]);
  useEffect(() => {
    if (tab !== "explore") return;
    try {
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          () => setLocationStatus("granted"),
          () => setLocationStatus("denied"),
        );
      } else setLocationStatus("denied");
    } catch {
      setLocationStatus("denied");
    }
  }, [tab]);

  // self-tests (lightweight)
  useEffect(() => {
    console.groupCollapsed("DEV tests");
    // IDs & relations
    console.assert(new Set(stores.map((s) => s.id)).size === stores.length, "unique store ids");
    console.assert(new Set(offers.map((o) => o.id)).size === offers.length, "unique offer ids");
    console.assert(stores.every((s) => s.id), "stores should have id");
    console.assert(offers.every((o) => stores.some((s) => s.id === o.storeId)), "every offer must map to a store");
    stores.forEach((s) => console.assert(storeItems(s.id).length <= 5, "each store <=5 items"));
    // cart scope & stock guard
    console.assert(Object.keys(cart).every((sid) => stores.some((s) => s.id === sid)), "cart store scope valid");
    Object.entries(cart).forEach(([sid, rec]) =>
      Object.entries(rec).forEach(([oid, q]) => {
        const of = offers.find((o) => o.id === oid);
        console.assert(of && of.storeId === sid, "cart offer must belong to store");
        if (of) console.assert(q <= of.left, "qty<=left");
      }),
    );
    // components exist
    console.assert(typeof Hero === "function" && typeof SearchBar === "function" && typeof CheckoutPage === "function", "core components exist");
    // subtotal math
    Object.keys(cart).forEach((sid) => {
      const entries = Object.entries(cart[sid] || {})
        .map(([oid, qty]) => ({ offer: offers.find((o) => o.id === oid), qty }))
        .filter((e) => e.offer);
      const subtotal = entries.reduce((s, e) => s + (e.offer!.price * e.qty), 0);
      const recompute = entries.map((e) => e.offer!.price * e.qty).reduce((a, b) => a + b, 0);
      console.assert(subtotal === recompute, "subtotal matches");
      console.assert(Number.isFinite(subtotal), "subtotal finite");
    });
    // filters sanity
    console.assert(offers.some((o) => getStore(o.storeId).distanceKm <= radiusKm + 0.0001), "radius filter has matches");
    // helper availability
    console.assert(typeof getStore === "function" && getStore("s1").id === "s1", "getStore works");
    // currency
    console.assert(/^¥/.test(currency(0)), "currency Yen");
    console.groupEnd();
  }, [cart, radiusKm]);

  const filteredOffers = useMemo(() => {
    const q = query.trim();
    const byQ = (o: any) => !q || o.name.includes(q) || getStore(o.storeId).name.includes(q);
    const byR = (o: any) => getStore(o.storeId).distanceKm <= radiusKm + 0.0001;
    const byC = (o: any) => selectedCats.length === 0 || selectedCats.some((c) => getStore(o.storeId).tags.includes(c));
    return offers.filter((o) => byQ(o) && byR(o) && byC(o));
  }, [query, radiusKm, selectedCats]);

  const sidInCart = firstStoreWithItems(cart);
  const storeNameInCart = sidInCart ? resolveStoreName(sidInCart, stores, offers) : null;

  const goHome = () => nav.reset({ name: "home", params: {} });
  const openStore = (sid: string) => nav.push({ name: "store", params: { sid } });
  const openProduct = (oid: string) => nav.push({ name: "product", params: { oid } });
  const openCheckout = (sid: string) => nav.push({ name: "checkout", params: { sid } });
  // 追加: 最初に商品が入っている店舗の checkout へ遷移
  // カートボタン（Home 以外にいても Home タブへ＆checkout へ）
  const goCart = () => {
    const sid = sidInCart;
    setTab("home");
    if (sid) {
      nav.push({ name: "checkout", params: { sid } });
    } else {
      nav.reset({ name: "home", params: {} });
    }
  };

  function onPay(item: any) {
    setTimeout(() => {
      setTicket({
        id: `TKT-${Math.floor(Math.random() * 9999)
          .toString()
          .padStart(4, "0")}`,
        offer: item,
        store: getStore(item.storeId),
        pickupCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
      });
      setCheckoutItem(null);
      setSelected(null);
      setTab("orders");
    }, 600);
  }
  function onCheckoutPay(sid: string) {
    const entries = Object.entries(cart[sid] || {}).filter(([, q]) => q > 0);
    if (!entries.length) {
      goHome();
      return;
    }
    entries.forEach(([oid, qty]) => {
      const of = offers.find((o) => o.id === oid);
      if (of) of.left = Math.max(0, of.left - qty);
    });
    const [firstOid, firstQty] = entries[0];
    const first = offers.find((o) => o.id === firstOid)!;
    setTicket({
      id: `TKT-${Math.floor(Math.random() * 9999)
        .toString()
        .padStart(4, "0")}`,
      offer: first,
      store: getStore(sid),
      pickupCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
      qty: firstQty,
    });
    setCart((p) => ({
      ...p,
      [sid]: {},
    }));
    nav.push({ name: "orders", params: {} });
    setTab("orders");
    lastFlowRefGlobal.value = "checkoutToOrders";
  }


  return (
    <NavCtx.Provider value={{ tab, setTab }}>
      <Shell
        route={route}
        nav={nav}
        onBack={() => (route.name !== "home" ? goHome() : null)}
        onHome={goHome}                   // ← 追加：親の goHome を渡す
        onOpenCart={goCart}
        cartStoreName={storeNameInCart}
        totalCartQty={totalCartQty}
      >
        {tab === "home" && route.name === "home" && (
          <div className="space-y-4">
            <Hero />
            <SearchBar query={query} setQuery={setQuery} />
            <div className="grid gap-4">
              {stores
                .filter(
                  (s) =>
                    !query.trim() ||
                    s.name.includes(query) ||
                    s.tags.some((t) => t.includes(query))
                )
                .map((s) => (
                  <StoreCard
                    key={s.id}
                    store={s}
                    items={storeItems(s.id)}
                    onOpen={() => openStore(s.id)}
                  />
                ))}
            </div>
          </div>
        )}

        {tab === "home" && route.name === "store" && route.params?.sid ? (
          <StoreDetailPage
            store={getStore(route.params.sid)}
            items={storeItems(route.params.sid)}
            cart={cart}
            cartQty={(oid: string) => cartQty(route.params.sid, oid)}
            setQty={(oid: string, q: number, max: number) => setQty(route.params.sid, oid, q, max)}
            onOpenProduct={openProduct}
            onCheckout={() => openCheckout(route.params.sid)}
          />
        ) : null}


        {tab === "home" && route.name === "product" && (
          <ProductDetailPage
            offer={offers.find((o) => o.id === route.params.oid)}
            store={getStore(offers.find((o) => o.id === route.params.oid)?.storeId || "s1")}
            cartQty={cartQty}
            setQty={setQty}
            onBack={() => nav.pop()}
            onCheckout={() =>
              openCheckout(offers.find((o) => o.id === route.params.oid)?.storeId || "s1")
            }
          />
        )}
        {tab === "home" && route.name === "checkout" && (
          <CheckoutPage
            store={getStore(route.params.sid)}
            items={storeItems(route.params.sid)}
            cart={cart[route.params.sid] || {}}
            setQty={(oid: string, q: number, max: number) => setQty(route.params.sid, oid, q, max)}
            onPay={() => onCheckoutPay(route.params.sid)}
          />

        )}

        {tab === "explore" && (
          <div className="space-y-3">
            {locationStatus === "denied" ? (
              <AddressFallback onSubmit={() => { }} />
            ) : (
              <div className="relative rounded-3xl overflow-hidden border">
                <MapCanvas offers={filteredOffers} onSelect={setSelected} />
                <ExploreOverlay
                  radiusKm={radiusKm}
                  setRadiusKm={setRadiusKm}
                  selectedCats={selectedCats}
                  setSelectedCats={setSelectedCats}
                  query={query}
                  setQuery={setQuery}
                />
              </div>
            )}
          </div>
        )}

        {tab === "favorites" && (
          <EmptyState
            icon={Heart}
            title="お気に入りがありません"
            subtitle="店舗やカテゴリをフォローすると、在庫復活や値下げをお知らせします。"
            actionLabel="近くの店舗を探す"
            onAction={() => setTab("explore")}
          />
        )}
        {tab === "orders" && (
          <Orders ticket={ticket} />
        )}
        {tab === "settings" && (
          <Settings />
        )}

        <AnimatePresence>
          {selected && (
            <DetailSheet
              offer={selected}
              store={getStore(selected.storeId)}
              onClose={() => setSelected(null)}
              onReserve={() => setCheckoutItem(selected)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {checkoutItem && (
            <CheckoutModal item={checkoutItem} onClose={() => setCheckoutItem(null)} onPay={() => onPay(checkoutItem)} />
          )}
        </AnimatePresence>
      </Shell>
    </NavCtx.Provider>
  );
}

// ---- shell & nav ----
function Shell({
  children, route, nav, onBack, onHome, onOpenCart, totalCartQty, cartStoreName,
}: {
  children: any;
  route: any;
  nav: NavHistory;
  onBack: () => void;
  onHome?: () => void;                  // ← 追加
  onOpenCart?: () => void;              // ★ これを追加
  totalCartQty?: number;
  cartStoreName?: string | null;
}) {
  const count = totalCartQty ?? 0;
  const showBack = route?.name !== "home";

  const navCtx = useNav?.() ?? { tab: "home", setTab: () => { } };
  const { tab: currentTab, setTab } = navCtx;
  // 親（Page）から route を更新できるよう、セット関数を props/クロージャで参照している前提です。
  // もしこのファイルで route を useState しているなら、その setRoute をここで閉じ込めてください。

  // ホームへ強制退避（タブ遷移 + ルート退避の両対応）
  const goHome = () => {
    // 親に route を home へ戻してもらう
    try { onHome?.(); } catch { }
    // 併せてタブも home へ
    try { setTab("home"); } catch { }
  };
  // ── 戻るボタンの制御（要件対応） ─────────────────────────────
  const handleBack = () => {
    const name = route?.name as Route["name"];
    if (name === "orders") {
      if (lastFlowRefGlobal.value === "checkoutToOrders") {
        lastFlowRefGlobal.value = null;
        nav.reset({ name: "home", params: {} });
        setTab("home");
        return;
      }
      nav.pop();
      return;
    }
    nav.pop();
    if (route?.name === "home") {
      setTab("home");
    }
  };

  const headerRight = (
    <div className="text-sm text-gray-500 flex items-center gap-2">
      <Bell className="w-4 h-4" />
      <span>通知</span>
      {count > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-600 text-white text-[11px] leading-none">
          {count}
        </span>
      )}
    </div>
  );

  return (
    <div className={`min-h-screen ${brand.bg} text-gray-900`}>
      <Header showBack={showBack} onBack={handleBack} rightContent={headerRight} />

      <main className={`${BAR_CONTAINER_CLASS} pt-3 pb-24 ${route?.name === "home" && count > 0 ? "pb-48" : ""}`}>
        {children}
      </main>

      {route?.name === "home" && count > 0 && (
        <HomeCartBanner
          count={count}
          storeName={cartStoreName ?? undefined}
          containerClassName={BAR_CONTAINER_CLASS}
          barClassName={BAR_OUTER_CLASS}
          buttonClassName={BAR_BTN_CLASS}
          onClick={() => {
            try { onOpenCart?.(); } catch { }
          }}
        />
      )}

      <Tabbar totalCartQty={count} onHome={goHome} tab={currentTab} setTab={setTab} />
    </div>
  );
}


// ---- store list & detail ----
function StoreCard({ store, items, onOpen }: { store: any; items: any[]; onOpen: () => void }) {
  const heroUrl = store?.imageUrl ?? items?.[0]?.img ?? null;
  return (
    <Card onClick={onOpen} className={`text-left cursor-pointer overflow-hidden border ${brand.card} shadow-sm rounded-3xl`}>
      {/* 店舗画像（ダミー対応）：16:9で切り抜き、上辺だけ角丸 */}
      <div className="relative w-full aspect-[21/9] overflow-hidden rounded-2xl">
        <img
          src={imgOrFallback("storeInterior", store.img, store.id, 1200)}
          alt={store.name}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
          decoding="async"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/20 to-transparent" />

        {/* テキスト情報を重ねる */}
        <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-base drop-shadow">{store.name}</div>
            <div className="text-sm flex items-center gap-1">
              <Star className="w-4 h-4 text-amber-400" />
              {store.rating}
            </div>
          </div>
          <div className="text-xs mt-1 flex items-center gap-2 text-gray-200">
            <MapPin className="w-4 h-4" />
            {store.distanceKm}km ・ {store.tags.join("・")}
          </div>
          {/* 登録商品数 */}
          <div className="mt-1 text-xs text-gray-200">
            登録商品：{Math.min(items.length, 5)} / 5
          </div>
        </div>
      </div>

      <div className="px-1 pt-4 pb-4">
        {/* 正方形サムネ（固定サイズ）で横スクロール */}
        <div className="mt-3 overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar -mx-1 px-1">
          <div className="flex gap-2">
            {items.slice(0, 5).map((i) => (
              <div
                key={i.id}
                className="shrink-0 w-[134px] snap-start rounded-xl border bg-white/80 overflow-hidden" // ← ★一辺120pxで固定
              >
                <div className="relative aspect-[3/2]">
                  <img src={imgOrFallback("product", i.img, i.id, 600)} className="w-full h-full object-cover" />

                  {/* 在庫（左上） */}
                  <span className={`absolute top-1 left-1 px-1.5 py-0.5 rounded-lg text-[10px] ${leftBadgeClass(i.left)}`}>
                    残{i.left}
                  </span>
                  {/* 価格/割引（右下） */}
                  <div className="absolute bottom-1 right-1">
                    <span className="px-1.5 py-0.5 rounded-lg bg-black/60 text-white text-[10px]">
                      {currency(i.price)}
                    </span>
                    {i.discount > 0 && (
                      <span className="ml-1 px-1.5 py-0.5 rounded-lg bg-emerald-600/90 text-white text-[10px]">
                        {i.discount}%OFF
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-2">
                  <div className="text-[11px] leading-4 line-clamp-2 text-gray-800">{i.name}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">{i.pickup}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* <div className="mt-2 text-xs text-gray-600">登録商品：{Math.min(items.length, 5)} / 5</div> */}
      </div>
    </Card>
  );
}

function StoreDetailPage({
  store,
  items,
  cart,
  cartQty,
  setQty,
  onOpenProduct,
  onCheckout,
}: {
  store: any;
  items: any[];
  cart: any;
  cartQty: (id: string) => number;
  setQty: (id: string, q: number, max: number) => void;
  onOpenProduct: (id: string) => void;
  onCheckout: () => void;
}) {
  if (!store) {
    return <div className="p-4 text-sm text-gray-500">店舗情報を読み込み中です…</div>;
  }
  const storeQty = Object.values(cart[store.id] || {}).reduce((s: number, q: any) => s + (Number(q) || 0), 0);
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-3xl border">
        {(() => {
          const pref = !isDummyImg(store?.img) ? store.img
            : !isDummyImg(items[0]?.img) ? items[0]?.img
              : null;
          const hero = imgOrFallback("storeInterior", pref, store.id, 1600);
          return (
            <img
              src={hero}
              className="w-full h-48 object-cover"
              alt={store.name}
            />
          );
        })()}

        <div className="absolute inset-0 bg-gradient-to-t from-black/40"></div>
        <div className="absolute bottom-3 left-3 text-white">
          <div className="text-lg font-bold flex items-center gap-2">
            {store.name}
            <span className="text-xs font-medium bg-white/20 px-2 py-0.5 rounded">登録商品 {items.length}/5</span>
          </div>
          <div className="text-xs text-white/90 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            {store.address}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-600 flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-500" />
          {store.rating}・{store.tags.join("・")}
        </div>
        <div className="text-sm text-gray-600">{store.distanceKm}km</div>
      </div>
      {/* 商品リスト */}

      <div className="flex flex-col gap-3 w-full max-w-full">
        {items.map((p) => (
          <div
            key={p.id}
            className={`w-full max-w-full box-border ${storeQty > 0 ? "last:mb-[90px]" : ""}`} // ← 最後だけ大きな余白
          >
            <ProductRow
              p={p}
              qty={cartQty(p.id)}
              setQty={(q) => setQty(p.id, q, p.left)}
              onOpen={() => onOpenProduct(p.id)}
            />
          </div>
        ))}
      </div>

      <div className="sticky bottom-24 inset-x-0">
        <CartBar storeId={store.id} items={items} cart={cart} onCheckout={onCheckout} />
      </div>
    </div>
  );
}

function ProductRow({ p, qty, setQty, onOpen }: { p: any; qty: number; setQty: (q: number) => void; onOpen: () => void }) {
  const [added, setAdded] = useState(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decDisabled = qty <= 0;
  const incDisabled = qty >= p.left;

  useEffect(() => {
    return () => {
      if (addTimer.current) {
        clearTimeout(addTimer.current);
      }
    };
  }, []);

  const handleDecrease = () => {
    if (decDisabled) return;
    setQty(Math.max(0, qty - 1));
  };

  const handleIncrease = () => {
    if (incDisabled) return;
    const nextQty = Math.min(qty + 1, p.left);
    if (nextQty === qty) return;
    setQty(nextQty);
    if (addTimer.current) {
      clearTimeout(addTimer.current);
    }
    setAdded(true);
    addTimer.current = setTimeout(() => setAdded(false), 1200);
  };

  return (
    <>
      <div className={`rounded-2xl border ${brand.card} p-3 flex items-center gap-3 overflow-hidden max-[360px]:flex-col max-[360px]:items-stretch`}>
        <button
          onClick={onOpen}
          className="w-20 h-20 max-[360px]:w-full max-[360px]:h-40 rounded-xl overflow-hidden border shrink-0"
        >
          <img src={imgOrFallback("product", p.img, p.id, 600)} className="w-full h-full object-cover" />


        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate break-words">{p.name}</div>
          <div className="text-xs text-gray-500 line-through">{currency(p.originalPrice)}</div>
          <div className="text-emerald-700 font-bold">
            {currency(p.price)} <span className="text-xs text-gray-500">{p.discount}%OFF</span>
          </div>
          <div className="text-[11px] text-gray-500">受取：{p.pickup}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0 max-[360px]:w-full max-[360px]:justify-end">
          <button
            type="button"
            onClick={handleDecrease}
            disabled={decDisabled}
            aria-disabled={decDisabled}
            title={decDisabled ? "これ以上減らせません" : "数量を1減らす"}
            className={`p-2 rounded-xl border ${decDisabled ? 'opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
          >
            <Minus className="w-4 h-4" />
          </button>
          <div className="w-8 text-center font-medium">{qty}</div>
          <button
            type="button"
            onClick={handleIncrease}
            disabled={incDisabled}
            aria-disabled={incDisabled}
            title={incDisabled ? `在庫は最大 ${p.left} です` : "数量を1増やす"}
            className={`p-2 rounded-xl border ${incDisabled ? 'opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>
      {/* 追加: ＋で増えたときの固定トースト */}

      {added && (
        <div
          className="
      fixed left-1/2 -translate-x-1/2
      bottom-[calc(env(safe-area-inset-bottom)+200px)]  /* ← カートバー高さぶん持ち上げ */
      z-40 flex justify-center px-4 pointer-events-none
    "
          aria-live="polite"
        >
          <div className="rounded-full bg-emerald-50 text-emerald-800 shadow px-4 py-2">
            カートに追加しました
          </div>
        </div>
      )}

    </>
  );
}



function CartBar({ storeId, items, cart, onCheckout }: { storeId: string; items: any[]; cart: any; onCheckout: () => void }) {
  const rec = cart[storeId] || {};
  const entries = items.filter((i) => (rec[i.id] || 0) > 0).map((i) => ({ ...i, qty: rec[i.id] }));
  const totalQty = entries.reduce((s, e) => s + e.qty, 0);
  const total = entries.reduce((s, e) => s + e.price * e.qty, 0);
  const ready = totalQty > 0;
  const storeQty =
    Object.values(cart[storeId] || {}).reduce((sum: number, q: any) => sum + (Number(q) || 0), 0);

  return (
    // …店舗詳細の中…
    <HomeCartBanner
      count={storeQty}
      storeName={getStore(storeId).name}  // ★ IDから店名を取得
      buttonLabel="カートを見る"
      disabled={storeQty === 0}
      onClick={onCheckout}
    />


  );
}
// ---- product detail ----
function ProductDetailPage({
  offer,
  store,
  cartQty,
  setQty,
  onBack,
  onCheckout,
}: {
  offer: any;
  store: any;
  cartQty: (sid: string, oid: string) => number;
  setQty: (sid: string, oid: string, q: number, max: number) => void;
  onBack: () => void;
  onCheckout: () => void;
}) {
  const [added, setAdded] = React.useState(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (addTimer.current) {
        clearTimeout(addTimer.current);
        addTimer.current = null;
      }
    };
  }, []);

  if (!offer) return null;

  const qty = cartQty(offer.storeId, offer.id);
  const decDisabled = qty <= 0;
  const incDisabled = qty >= offer.left;
  const storeQty = React.useMemo(() => {
    return storeItems(offer.storeId)
      .reduce((sum, i) => sum + (cartQty(offer.storeId, i.id) || 0), 0);
  }, [offer.storeId, cartQty]);

  return (
    <>
      <div className="space-y-4">
        <div className="relative overflow-hidden rounded-3xl border">
          <img src={imgOrFallback("product", offer.img, offer.id, 1200)} className="w-full h-48 object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30"></div>
          <button onClick={onBack} className="absolute top-3 left-3 p-2 rounded-full border bg-white/80">
            <ArrowLeft className="w-5 h-5" />
          </button>
        </div>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold">{offer.name}</div>
            <div className="text-xs text-gray-500 flex items-center gap-2">
              <MapPin className="w-4 h-4" />
              {store?.name}
            </div>
            <div className="text-[12px] text-gray-500">受取：{offer.pickup}</div>
          </div>
          <div className="text-right">
            <div className="text-emerald-700 font-extrabold text-xl">{currency(offer.price)}</div>
            <div className="text-xs text-gray-400 line-through">{currency(offer.originalPrice)}</div>
          </div>
        </div>
        <div>
          <div className="text-sm font-medium mb-1">アレルゲン</div>
          {offer.allergens.length ? (
            <div className="flex flex-wrap gap-2">
              {offer.allergens.map((a: string) => (
                <span key={a} className="px-2 py-1 rounded-xl bg-gray-100 text-gray-700 text-xs">
                  {a}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-500">特定原材料なし</div>
          )}
        </div>
        <div className="flex items-center justify-between rounded-2xl border bg-white/70 backdrop-blur p-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (decDisabled) return;
                setQty(offer.storeId, offer.id, Math.max(0, qty - 1), offer.left);
              }}
              disabled={decDisabled}
              aria-disabled={decDisabled}
              title={decDisabled ? "これ以上減らせません" : "数量を1減らす"}
              className={`p-2 rounded-xl border ${decDisabled ? 'opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
            >
              <Minus className="w-4 h-4" />
            </button>
            <div className="w-10 text-center font-medium">{qty}</div>
            <button
              type="button"
              onClick={() => {
                if (incDisabled) return;
                const nextQty = Math.min(qty + 1, offer.left);
                if (nextQty === qty) return;
                setQty(offer.storeId, offer.id, nextQty, offer.left);
                if (addTimer.current) {
                  clearTimeout(addTimer.current);
                  addTimer.current = null;
                }
                console.log("[ProductDetailPage] addToCart clicked", { next: nextQty, offer: offer.id });
                setAdded(true);
                addTimer.current = setTimeout(() => {
                  setAdded(false);
                  addTimer.current = null;
                }, 1200);
              }}
              disabled={incDisabled}
              aria-disabled={incDisabled}
              title={incDisabled ? `在庫は最大 ${offer.left} です` : "数量を1増やす"}
              className={`p-2 rounded-xl border ${incDisabled ? 'opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 text-right text-xs text-gray-500">＋ボタンで数量を追加すると自動でカートに反映されます</div>
        </div>
        <div className="text-xs text-gray-500">
          在庫：<span className={`px-2 py-1 rounded-xl ${leftBadgeClass(offer.left)}`}>残り {offer.left}</span>
        </div>
      </div>
      {/* 追加: 商品詳細の＋で増えたときの固定トースト */}
      {added && (
        <div
          className="fixed z-[60] bottom-24 left-1/2 -translate-x-1/2
                     rounded-2xl border border-emerald-300 bg-emerald-50
                     text-emerald-900 text-sm px-4 py-2 shadow-lg"
          aria-live="polite"
        >
          カートに追加しました
        </div>
      )}
      {storeQty > 0 && <div aria-hidden className="h-[90px]" />}
      <div className="max-w-md mx-auto px-4 space-y-4 overflow-x-hidden">
        <HomeCartBanner
          count={storeQty}
          storeName={store?.name ?? "この店舗"}
          buttonLabel="カートを見る"
          disabled={storeQty === 0}
          onClick={onCheckout}
        />
      </div>
    </>

  );
}

// ---- checkout (per store) ----
// ---- checkout (per store) ----
function CheckoutPage({
  store,
  items,
  cart,
  setQty,
  onPay,
}: {
  store: any;
  items: Offer[];
  cart: Record<string, number>;
  setQty: (oid: string, q: number, max: number) => void;
  onPay: () => void;
}) {
  // エントリ生成（現状の表示は維持）
  // 0個でも行は残す（filter をやめる）
  const entries = Object.entries(cart)
    .map(([oid, qty]) => ({ offer: offers.find((o) => o.id === oid)!, qty }))
    .filter((e) => e.offer);

  // 合計個数で「決済へ進む」を制御（= 1個以上で有効）
  const totalQty = entries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
  const subtotal = entries.reduce((s, e) => s + e.offer.price * (Number(e.qty) || 0), 0);
  const ready = totalQty > 0;


  // 受取時間（この店舗の商品から候補生成）
  const pickupOptions = React.useMemo(
    () => Array.from(new Set(items.map((i) => i.pickup))).filter(Boolean),
    [items]
  );
  const [pickupWindow, setPickupWindow] = useState<string>(pickupOptions[0] || "");

  // クーポン（見た目のみ。小計計算は現状維持）
  const [couponType, setCouponType] = useState<"none" | "percent10" | "fixed100">("none");
  const [couponApplied, setCouponApplied] = useState(false);

  return (
    <div className="space-y-4">
      {/* ヘッダー（現状維持） */}
      <div className="rounded-3xl border overflow-hidden">
        <div className="p-4 bg-white/70 backdrop-blur border-b">
          <div className="font-semibold">{store.name} のお会計</div>
          <div className="text-xs text-gray-500">受取場所：{store.address}</div>
        </div>

        {/* 注文内容（各行に数量ステッパーを追加） */}
        <div className="divide-y">
          {entries.map(({ offer, qty }) => {
            const decDisabled = qty <= 0;
            const incDisabled = qty >= offer.left;
            return (
              <div key={offer.id} className="p-4 flex items-center justify-between gap-3">
                {/* 左側（現状の表示を維持） */}
                <div className="flex items-center gap-3 min-w-0">
                  <img src={imgOrFallback("product", offer.img, offer.id, 600)} className="w-12 h-12 rounded-lg object-cover border" />

                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{offer.name}</div>
                    <div className="text-xs text-gray-500">受取：{offer.pickup}</div>
                  </div>
                </div>

                {/* 右側：数量ステッパー＋金額 */}
                <div className="shrink-0 text-right">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setQty(offer.id, Math.max(0, qty - 1), offer.left)}
                      disabled={decDisabled}
                      aria-disabled={decDisabled}
                      className={`p-2 rounded-xl border ${decDisabled ? "opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                      title={decDisabled ? "これ以上減らせません" : "数量を1減らす"}
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="w-8 text-center font-medium tabular-nums">{qty}</div>
                    <button
                      type="button"
                      onClick={() => setQty(offer.id, Math.min(qty + 1, offer.left), offer.left)}
                      disabled={incDisabled}
                      aria-disabled={incDisabled}
                      className={`p-2 rounded-xl border ${incDisabled ? "opacity-40 cursor-not-allowed text-emerald-400 border-emerald-100" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                      title={incDisabled ? `在庫は最大 ${offer.left} です` : "数量を1増やす"}
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-emerald-700 tabular-nums">
                    {currency(offer.price * qty)}
                  </div>
                </div>
              </div>
            );
          })}
          {!entries.length && (
            <div className="p-4 text-sm text-gray-500">
              カートが空です。店舗ページに戻って商品を追加してください。
            </div>
          )}
        </div>

        {/* 小計（現状維持） */}
        <div className="p-4 flex items-center justify-between bg-gray-50">
          <div className="text-sm">小計</div>
          <div className="text-base font-bold">{currency(subtotal)}</div>
        </div>
      </div>

      {/* 支払い方法ブロックは削除 → 代わりに受取時間＆クーポン（追加） */}
      <div className="rounded-3xl border bg-white/70 backdrop-blur p-4 space-y-3">
        {/* 受け取り時間 */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm text-gray-600 self-center">受け取り時間</label>
          <select
            className="h-10 rounded-xl border px-3"
            value={pickupWindow}
            onChange={(e) => setPickupWindow(e.target.value)}
          >
            {pickupOptions.length === 0 && <option value="">選択してください</option>}
            {pickupOptions.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>

        {/* クーポン */}
        {/* クーポン（はみ出し防止のレイアウト） */}
        <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2">
          <label className="text-sm text-gray-600">クーポン</label>

          {/* 右側：選択 + 適用ボタン（横並び） */}
          <div className="min-w-0 flex items-center gap-2">
            <select
              className="h-10 w-full min-w-0 flex-1 rounded-xl border px-3 truncate"
              value={couponType}
              onChange={(e) => {
                setCouponType(e.target.value as typeof couponType);
                setCouponApplied(false);
              }}
            >
              <option value="none">なし</option>
              <option value="percent10">10%OFF</option>
              <option value="fixed100">¥100 OFF</option>
            </select>

            <Button
              variant={couponApplied ? "secondary" : "primary"}
              size="sm"
              onClick={() => setCouponApplied((x) => !x)}
              disabled={couponType === "none"}
              className="flex-shrink-0 !h-10 !px-4 !whitespace-nowrap"
            >
              {couponApplied ? "適用中" : "適用"}
            </Button>
          </div>
        </div>

      </div>

      {/* 注記（現状維持） */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Check className="w-4 h-4" />
        店頭受取のため送料はかかりません
      </div>

      {/* 画面下の固定サマリー（合計は現状のまま） */}
      <div className="sticky bottom-24 inset-x-0">
        <div className={BAR_CONTAINER_CLASS}>
          <div className={BAR_OUTER_CLASS}>
            <div className="text-sm">
              合計 <span className="font-semibold">{currency(subtotal)}</span>
            </div>
            <button
              disabled={!ready}
              onClick={onPay}
              className={`${BAR_BTN_CLASS} ${!ready ? "bg-white/60 text-emerald-700/50 cursor-not-allowed" : ""}`}
            >
              決済へ進む
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- explore ----
function MapCanvas({ offers, onSelect }: { offers: any[]; onSelect: (o: any) => void }) {
  return (
    <div className="h-[60vh] bg-[conic-gradient(at_30%_120%,#dcfce7,white,#bbf7d0)] relative">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="w-3 h-3 rounded-full bg-emerald-600 border-2 border-white shadow"></div>
        <div className="text-[10px] text-emerald-700 mt-1 text-center">現在地</div>
      </div>
      {offers.map((o, idx) => (
        <button key={o.id} onClick={() => onSelect(o)} className="absolute" style={{ left: `${20 + idx * 20}%`, top: `${30 + ((idx % 2) * 25)}%` }}>
          <div className="px-2 py-1 rounded-xl bg-white shadow border text-xs flex items-center gap-1">
            <span className="font-medium">{currency(o.price)}</span>
            <span className="text-[10px] text-gray-500">{o.discount}%</span>
          </div>
        </button>
      ))}
    </div>
  );
}
function ExploreOverlay({
  radiusKm,
  setRadiusKm,
  selectedCats,
  setSelectedCats,
  query,
  setQuery,
}: {
  radiusKm: number;
  setRadiusKm: (n: number) => void;
  selectedCats: string[];
  setSelectedCats: (v: string[]) => void;
  query: string;
  setQuery: (v: string) => void;
}) {
  const toggle = (c: string) => (selectedCats.includes(c) ? setSelectedCats(selectedCats.filter((x) => x !== c)) : setSelectedCats([...selectedCats, c]));
  const chips = ["ベーカリー", "惣菜", "スーパー", "和食", "ヴィーガン対応", "アレルゲン表示"];
  return (
    <div className="absolute inset-x-3 top-3 space-y-3">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-2xl border bg-white/90 shadow ${brand.ring}`}>
        <Search className="w-4 h-4 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="キーワード検索"
          className="w-full bg-transparent text-sm focus:outline-none"
        />
        <button className="text-xs px-2 py-1 rounded-xl border">クリア</button>
      </div>
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {chips.map((c) => (
          <button
            key={c}
            onClick={() => toggle(c)}
            className={`px-3 py-1.5 rounded-full border text-xs whitespace-nowrap ${selectedCats.includes(c) ? "bg-emerald-600 text-white border-emerald-600" : "bg-white/90"
              }`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="px-3 py-2 rounded-2xl border bg-white/90 shadow flex items-center gap-3">
        <MapPin className="w-4 h-4 text-emerald-600" />
        <input
          type="range"
          min="0.5"
          max="5"
          step="0.5"
          value={radiusKm}
          onChange={(e) => setRadiusKm(parseFloat((e.target as HTMLInputElement).value))}
          className="w-full"
        />
        <span className="text-sm w-12 text-right">{radiusKm}km</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-emerald-900">
        <span className="px-2 py-1 rounded-full bg-white/80 border">①ピン</span>
        <span className="px-2 py-1 rounded-full bg-white/80 border">②予約して支払う</span>
        <span className="px-2 py-1 rounded-full bg-white/80 border">③決済</span>
        <span className="ml-auto">＝ 3タップで予約完了</span>
      </div>
    </div>
  );
}
function AddressFallback({ onSubmit }: { onSubmit: (a: string) => void }) {
  return (
    <div className="rounded-3xl border bg-white/80 backdrop-blur p-5">
      <div className="font-semibold">位置情報の許可が必要です</div>
      <div className="text-sm text-gray-500 mt-1">許可しない場合は、駅名や住所で検索してください。</div>
      <div className="mt-3 flex gap-2">
        <input className="flex-1 px-3 py-2 rounded-xl border" placeholder="例）品川駅 / 港区芝公園" />
        <button className={`px-3 py-2 rounded-xl border ${brand.ring}`} onClick={() => onSubmit("")}>
          検索
        </button>
      </div>
      <div className="text-xs text-gray-500 mt-2">設定→位置情報→許可 でいつでも切り替えられます。</div>
    </div>
  );
}
function DetailSheet({ offer, store, onClose, onReserve }: { offer: any; store: any; onClose: () => void; onReserve: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end justify-center"
      initial={{ backgroundColor: "rgba(0,0,0,0)", opacity: 0 }}
      animate={{ backgroundColor: "rgba(0,0,0,0.5)", opacity: 1 }}
      exit={{ backgroundColor: "rgba(0,0,0,0)", opacity: 0 }}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden"
      >
        <div className="relative">
          <img src={imgOrFallback("product", offer.img, offer.id, 1200)} className="w-full aspect-[16/9] object-cover" />

          <button onClick={onClose} className="absolute top-3 right-3 p-2 bg-white/80 rounded-full border">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold">{offer.name}</h3>
              <div className="text-sm text-gray-600 flex items-center gap-2 mt-1">
                <MapPin className="w-4 h-4" />
                {store.name}（{store.distanceKm}km）<span className="mx-1">•</span>
                <Star className="w-4 h-4 text-amber-500" />
                {store.rating}
              </div>
            </div>
            <div className="text-right">
              <div className="text-emerald-700 font-extrabold text-xl">{currency(offer.price)}</div>
              <div className="text-xs text-gray-400 line-through">{currency(offer.originalPrice)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-700">
            <Clock className="w-4 h-4" />
            受取：{offer.pickup}
            <span className={`text-xs px-2 py-1 rounded-xl ${leftBadgeClass(offer.left)}`}>残り {offer.left}</span>
          </div>
          <div className="text-sm text-gray-600">
            <div className="mb-1 font-medium">アレルゲン</div>
            {offer.allergens.length ? (
              <div className="flex flex-wrap gap-2">
                {offer.allergens.map((a: string) => (
                  <span key={a} className="px-2 py-1 rounded-xl bg-gray-100 text-gray-700 text-xs">
                    {a}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-500">特定原材料なし（店舗表示に準拠）</div>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <ChevronRight className="w-4 h-4 rotate-90" />
            {store.address}
          </div>
        </div>
        <div className="p-4 border-t bg-white">
          <button onClick={onReserve} className={`w-full py-3 rounded-2xl bg-emerald-600 text-white font-semibold shadow-sm ${brand.ring}`}>
            <ShoppingBag className="w-5 h-5 inline -mt-1 mr-1" /> 予約して支払う
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
function CheckoutModal({ item, onClose, onPay }: { item: any; onClose: () => void; onPay: () => void }) {
  const [method, setMethod] = useState<"paypay" | "card">("paypay");
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      initial={{ backgroundColor: "rgba(0,0,0,0)", opacity: 0 }}
      animate={{ backgroundColor: "rgba(0,0,0,0.5)", opacity: 1 }}
      exit={{ backgroundColor: "rgba(0,0,0,0)", opacity: 0 }}
    >
      <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }} className="w-full max-w-md rounded-3xl bg-white shadow-2xl overflow-hidden">
        <div className="p-5 border-b">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs text-gray-500">支払い</div>
              <div className="font-bold">{item.name}</div>
            </div>
            <button onClick={onClose} className="p-2 rounded-full border bg-white/80">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <img src={imgOrFallback("product", item.img, item.id, 600)} className="w-16 h-16 object-cover rounded-xl border" />

            <div className="flex-1">
              <div className="font-semibold">{item.name}</div>
              <div className="text-xs text-gray-500">受取：{item.pickup}</div>
            </div>
            <div className="text-right">
              <div className="text-emerald-700 font-extrabold">{currency(item.price)}</div>
              <div className="text-xs text-gray-400 line-through">{currency(item.originalPrice)}</div>
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">支払い方法</div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMethod("paypay")}
                className={`p-3 rounded-2xl border text-sm flex items-center justify-center gap-2 ${method === "paypay" ? "border-emerald-500 bg-emerald-50" : ""
                  }`}
              >
                <Smartphone className="w-4 h-4" />
                PayPay
              </button>
              <button
                onClick={() => setMethod("card")}
                className={`p-3 rounded-2xl border text-sm flex items-center justify-center gap-2 ${method === "card" ? "border-emerald-500 bg-emerald-50" : ""
                  }`}
              >
                <CreditCard className="w-4 h-4" />
                クレジットカード
              </button>
            </div>
            <div className="text-xs text-gray-500 mt-2">Stripe Checkoutで処理（デモ）</div>
          </div>
        </div>
        <div className="p-5 border-t bg-gray-50">
          <button onClick={onPay} className={`w-full py-3 rounded-2xl bg-emerald-600 text-white font-semibold shadow-sm ${brand.ring}`}>
            {method === "paypay" ? "PayPayで支払う" : "カードで支払う"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
// ---- orders & settings ----
function Orders({ ticket }: { ticket: any }) {
  const { setTab } = useNav();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold tracking-tight">受取チケット & 履歴</h2>
      {ticket ? (
        <TicketCard t={ticket} />
      ) : (
        <EmptyState
          icon={History}
          title="注文はまだありません"
          subtitle="近くの余剰品を予約すると、ここにチケットが表示されます。"
          actionLabel="探す"
          onAction={() => setTab("explore")}
        />
      )}
      <div>
        <div className="text-sm font-medium mb-2">過去の注文</div>
        <div className="grid gap-3">
          <HistoryRow title="お楽しみパンBOX（3点）" store="グリーンベーカリー" when="昨日" price="¥490" />
          <HistoryRow title="野菜詰合せ（規格外）" store="Sunny Super" when="先週" price="¥480" />
        </div>
      </div>
    </div>
  );
}
function TicketCard({ t }: { t: any }) {
  return (
    <div className={`rounded-3xl border ${brand.card} p-4`}>
      <div className="flex items-start gap-3">
        <img src={imgOrFallback("product", t.offer.img, t.offer.id, 600)} className="w-16 h-16 rounded-xl object-cover border" />
        <div className="flex-1">
          <div className="font-semibold">{t.offer.name}</div>
          <div className="text-xs text-gray-500">{t.store.name}・受取 {t.offer.pickup}</div>
        </div>
        <span className="text-emerald-700 font-bold">{currency(t.offer.price)}</span>
      </div>
      <div className="mt-4 p-4 rounded-2xl bg-gray-50 border flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">チケットID</div>
          <div className="font-mono text-sm">{t.id}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-500 text-right">
            <div>受取コード</div>
            <div className="font-mono">{t.pickupCode}</div>
          </div>
          <div className="p-2 rounded-xl bg-white border">
            <div className="grid grid-cols-5 gap-0.5">
              {Array.from({ length: 25 }).map((_, i) => (
                <div key={i} className={`w-2 h-2 ${i % 3 === 0 ? "bg-gray-900" : "bg-gray-200"}`}></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs text-gray-500">受け取りの際、このQRまたは受取コードを店舗スタッフへ提示してください。</div>
    </div>
  );
}
function HistoryRow({ title, store, when, price }: { title: string; store: string; when: string; price: string }) {
  return (
    <div className="rounded-2xl border bg-white/70 backdrop-blur p-3 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-gray-500">
          {store}・{when}
        </div>
      </div>
      <div className="text-sm text-gray-700">{price}</div>
    </div>
  );
}
function Settings() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold tracking-tight">アカウント</h2>
      <div className="rounded-3xl border bg-white/70 backdrop-blur">
        <div className="p-4 border-b">
          <div className="font-semibold">通知設定</div>
          <div className="text-xs text-gray-500">在庫復活・受取リマインド・価格ドロップ</div>
        </div>
        <div className="divide-y">
          <Row label="在庫復活（お気に入り）" />
          <Row label="価格が下がったとき" />
          <Row label="受け取りリマインド" />
        </div>
      </div>
      <div className="rounded-3xl border bg-white/70 backdrop-blur">
        <div className="p-4 border-b">
          <div className="font-semibold">言語・地域</div>
          <div className="text-xs text-gray-500">日本語 / JPY / 東京</div>
        </div>
        <div className="divide-y">
          <Row label="言語" value="日本語" />
          <Row label="通貨" value="JPY" />
          <Row label="位置情報の許可" value="ON" />
        </div>
      </div>
      <div className="rounded-3xl border bg-white/70 backdrop-blur">
        <div className="p-4 border-b">
          <div className="font-semibold">ヘルプ & ポリシー</div>
          <div className="text-xs text-gray-500">よくある質問 / 返金・不来店ポリシー</div>
        </div>
        <div className="divide-y">
          <Row label="よくある質問" trailing={<ChevronRight className="w-4 h-4" />} />
          <Row label="返金・不来店ポリシー" trailing={<ChevronRight className="w-4 h-4" />} />
          <Row label="利用規約 / プライバシー" trailing={<ChevronRight className="w-4 h-4" />} />
        </div>
      </div>
    </div>
  );
}
function Row({ label, value, trailing }: { label: string; value?: string; trailing?: any }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between">
      <div className="text-sm text-gray-700">{label}</div>
      <div className="text-sm text-gray-500 flex items-center gap-2">
        {value}
        {trailing}
      </div>
    </div>
  );
}
function EmptyState({ icon: Icon, title, subtitle, actionLabel, onAction }: { icon: any; title: string; subtitle: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="text-center rounded-3xl border bg-white/70 backdrop-blur p-8">
      <Icon className="w-10 h-10 mx-auto text-emerald-600" />
      <div className="mt-2 font-semibold">{title}</div>
      <div className="text-sm text-gray-500 mt-1">{subtitle}</div>
      {actionLabel && (
        <button onClick={onAction} className={`mt-4 px-4 py-2 rounded-xl border ${brand.ring}`}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
