"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// TODO(req v2): 型は supabase gen types 由来へ差し替え
type OrderStatus = "PENDING" | "FULFILLED" | string;
type OrderItem = { id: string; name: string; qty: number; price?: number | null };
type OrdersRow = {
  id: string | number;
  store_id?: string | null;
  total: number | string | null;
  status: OrderStatus;
  placed_at: string | null;
  items: OrderItem[] | null;
};

function getStoreId() {
  if (typeof window !== "undefined" && (window as any).__STORE_ID__) return String((window as any).__STORE_ID__);
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_STORE_ID) return String(process.env.NEXT_PUBLIC_STORE_ID);
  return "";
}

function useSupabase(): SupabaseClient | null {
  return useMemo(() => {
    if (typeof window === "undefined") return null;
    const w = window as any;
    if (w.__supabase) return w.__supabase as SupabaseClient;
    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined) || w.NEXT_PUBLIC_SUPABASE_URL;
    const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined) || w.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sid = getStoreId();
    if (!url || !key) return null;
    try {
      const sb = createClient(url, key, { global: { headers: { "x-store-id": String(sid || "") } } });
      (w as any).__supabase = sb;
      return sb;
    } catch {
      return null;
    }
  }, []);
}

const yen = (n: number) => n.toLocaleString("ja-JP", { style: "currency", currency: "JPY" });
const toDateKey = (iso: string) => {
  // ローカル日付キー（YYYY-MM-DD）
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const storeTake = (price: number | string) => Math.floor(Number(price || 0) * 0.8);

type RangePreset = "today" | "7d" | "30d" | "custom";

function computeDefaultRange(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from = new Date(to);
  if (preset === "today") from = new Date(to);
  if (preset === "7d") from = new Date(to.getTime() - 6 * 86400000);
  if (preset === "30d") from = new Date(to.getTime() - 29 * 86400000);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(from), to: fmt(to) };
}

export default function AnalyticsPage() {
  const supabase = useSupabase();
  const [hydrated, setHydrated] = useState(false);
  const [preset, setPreset] = useState<RangePreset>("7d");
  // ★ SSR時は空にしておき、クライアントで埋める
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<OrdersRow[]>([]);

  const reloadByPreset = useCallback((p: RangePreset) => {
    setPreset(p);
    const r = computeDefaultRange(p);
    setFrom(r.from);
    setTo(r.to);
  }, []);

  const load = useCallback(async () => {
    if (!supabase) return;
    if (!from || !to) return; // ★ 日付未設定なら何もしない（初回のSSR直後対策）
    setLoading(true);
    setError(null);
    try {
      // 期間の境界を UTC ISO に近似（00:00〜23:59:59）
      const fromIso = new Date(`${from}T00:00:00`).toISOString();
      const toIso = new Date(`${to}T23:59:59`).toISOString();
      const sid = getStoreId();
      let q = supabase
        .from("orders")
        .select("id,store_id,total,status,placed_at,items")
        .eq("store_id", sid)
        .gte("placed_at", fromIso)
        .lte("placed_at", toIso)
        .order("placed_at", { ascending: false })
        .limit(2000);
      const { data, error } = await q;
      if (error) throw error;
      setRows((data ?? []) as OrdersRow[]);
    } catch (e: any) {
      setError(e?.message || String(e));
      setRows([]);
    }
    setLoading(false);
  }, [supabase, from, to]);

  // ★ マウント後にデフォルト日付を設定し、その後ロード
  useEffect(() => {
    setHydrated(true);
    // 初回のみ日付を決定（タイムゾーン差でのズレを防ぐ）
    const r = computeDefaultRange("7d");
    setFrom(r.from);
    setTo(r.to);
  }, []);

  useEffect(() => {
    if (hydrated && from && to) {
      void load();
    }
  }, [hydrated, from, to, load]);

  const metrics = useMemo(() => {
    const all = rows;
    const totalCount = all.length;
    const fulfilled = all.filter(r => String(r.status).toUpperCase() === "FULFILLED");
    const pending = all.filter(r => String(r.status).toUpperCase() !== "FULFILLED");

    const gross = fulfilled.reduce((a, r) => a + Number(r.total ?? 0), 0);
    const revenue = fulfilled.reduce((a, r) => a + storeTake(Number(r.total ?? 0)), 0);
    const aov = fulfilled.length ? Math.round(gross / fulfilled.length) : 0;

    // 日別集計（総売上と受注数）
    const byDay = new Map<string, { gross: number; revenue: number; count: number }>();
    for (const r of fulfilled) {
      const key = r.placed_at ? toDateKey(r.placed_at) : "";
      if (!key) continue;
      const cur = byDay.get(key) || { gross: 0, revenue: 0, count: 0 };
      cur.gross += Number(r.total ?? 0);
      cur.revenue += storeTake(Number(r.total ?? 0));
      cur.count += 1;
      byDay.set(key, cur);
    }

    // 商品別（qty / 売上）
    const byItem = new Map<string, { name: string; qty: number; gross: number }>();
    for (const r of fulfilled) {
      const items = Array.isArray(r.items) ? r.items : [];
      for (const it of items) {
        const key = String(it.id);
        const cur = byItem.get(key) || { name: String(it.name ?? "商品"), qty: 0, gross: 0 };
        const qty = Math.max(0, Number(it.qty || 0));
        const price = Math.max(0, Number((it as any).price ?? 0));
        cur.qty += qty;
        cur.gross += price * qty;
        byItem.set(key, cur);
      }
    }

    const series = Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, ...v }));
    const topItemsByQty = Array.from(byItem.values()).sort((a, b) => b.qty - a.qty).slice(0, 5);
    const topItemsByGross = Array.from(byItem.values()).sort((a, b) => b.gross - a.gross).slice(0, 5);

    return {
      totalCount,
      fulfilledCount: fulfilled.length,
      pendingCount: pending.length,
      gross,
      revenue,
      aov,
      series,
      topItemsByQty,
      topItemsByGross,
    } as const;
  }, [rows]);

  const [insights, setInsights] = useState<string[]>([]);
  const regenerateInsights = useCallback(() => {
    const m = metrics;
    const s: string[] = [];
    // 簡易ヒューリスティック分析（Phase 0）。将来は LLM 連携。
    if (m.series.length > 0) {
      const best = [...m.series].sort((a, b) => b.gross - a.gross)[0];
      const worst = [...m.series].sort((a, b) => a.gross - b.gross)[0];
      s.push(`期間内の総売上は ${yen(m.gross)}、受注数は ${m.fulfilledCount} 件です。`);
      s.push(`1件あたり平均売上（AOV）は ${yen(m.aov)} でした。`);
      if (best) s.push(`日別の最高売上日は ${best.date}（${yen(best.gross)}）です。`);
      if (worst) s.push(`日別の最低売上日は ${worst.date}（${yen(worst.gross)}）です。`);
      if (m.topItemsByQty[0]) s.push(`数量ベースの人気商品: 「${m.topItemsByQty[0].name}」が最多販売です。`);
      if (m.topItemsByGross[0]) s.push(`売上ベースの主力商品: 「${m.topItemsByGross[0].name}」が売上トップです。`);
      const pendingRatio = m.totalCount > 0 ? Math.round((m.pendingCount / m.totalCount) * 100) : 0;
      if (pendingRatio >= 10) s.push(`未引換比率がやや高め（${pendingRatio}%）。受け渡し動線の確認をご検討ください。`);
    } else {
      s.push("該当期間の売上データがありません。");
    }
    setInsights(s);
  }, [metrics]);

  useEffect(() => { regenerateInsights(); }, [regenerateInsights]);

  // ★ マウント完了＆日付が揃うまでは必ずdisabled
  const disabled = !hydrated || !from || !to || loading || !supabase;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="mb-3">
        <a
          href="/#/orders"
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm bg-white hover:bg-zinc-50"
        >
          ← 店舗アプリへ戻る
        </a>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight mb-4">売上・収益（期間分析）</h1>

      {/* フィルタ */}
      <div className="rounded-2xl border bg-white p-4 mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-zinc-600">期間</label>
          <div className="flex items-center gap-1">
            {(["today", "7d", "30d"] as RangePreset[]).map(p => (
              <button
                key={p}
                onClick={() => reloadByPreset(p)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${preset === p ? "bg-zinc-900 text-white" : "bg-white hover:bg-zinc-50"}`}
                disabled={loading}
              >{p === "today" ? "今日" : p === "7d" ? "過去7日" : "過去30日"}</button>
            ))}
            <button
              onClick={() => setPreset("custom")}
              className={`px-3 py-1.5 rounded-lg text-sm border ${preset === "custom" ? "bg-zinc-900 text-white" : "bg-white hover:bg-zinc-50"}`}
              disabled={loading}
            >カスタム</button>
          </div>

          <div className="md:ml-auto ml-0 flex flex-wrap items-center gap-2 w-full">
            {/* 日付入力（小画面では横幅いっぱい） */}
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border px-2 py-1 text-xs sm:text-sm flex-1 min-w-[120px] sm:min-w-[10rem]"
            />
            <span className="text-zinc-500 shrink-0">〜</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border px-2 py-1 text-xs sm:text-sm flex-1 min-w-[120px] sm:min-w-[10rem]"
            />

            {/* 更新ボタン（小画面は幅いっぱいで改行） */}
            <button
              onClick={async (e) => {
                e.preventDefault();
                await load();
              }}
              disabled={disabled}
              className="rounded-lg px-2 sm:px-3 py-1.5 text-xs sm:text-sm text-white bg-zinc-900 disabled:bg-zinc-400
               w-full sm:w-auto shrink-0"
            >
              更新
            </button>
          </div>

        </div>
        {error ? <div className="text-sm text-red-600">{error}</div> : null}
      </div>

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <KPI title="総売上" value={yen(metrics.gross)} note="（FULFILLED のみ）" />
        <KPI title="収益（見込）" value={yen(metrics.revenue)} note="手数料差引き後 80%" />
        <KPI title="受注数" value={`${metrics.fulfilledCount} 件`} note={`未引換 ${metrics.pendingCount} 件`} />
        <KPI title="平均売上（AOV）" value={yen(metrics.aov)} />
      </div>

      {/* 日別推移 */}
      <section className="rounded-2xl border bg-white p-4 mb-4">
        <h2 className="text-lg font-semibold mb-2">日別推移</h2>
        {metrics.series.length === 0 ? (
          <div className="text-sm text-zinc-600">データがありません。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[600px] text-sm">
              <thead>
                <tr className="text-zinc-600">
                  <th className="text-left font-medium p-2">日付</th>
                  <th className="text-right font-medium p-2">受注数</th>
                  <th className="text-right font-medium p-2">売上</th>
                  <th className="text-right font-medium p-2">収益（見込）</th>
                </tr>
              </thead>
              <tbody>
                {metrics.series.map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="p-2">{d.date}</td>
                    <td className="p-2 text-right tabular-nums">{d.count}</td>
                    <td className="p-2 text-right tabular-nums">{yen(d.gross)}</td>
                    <td className="p-2 text-right tabular-nums">{yen(d.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 商品別トップ */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="rounded-2xl border bg-white p-4">
          <h2 className="text-lg font-semibold mb-2">商品別（数量）トップ</h2>
          {metrics.topItemsByQty.length === 0 ? <div className="text-sm text-zinc-600">データがありません。</div> : (
            <ul className="text-sm">
              {metrics.topItemsByQty.map((i, idx) => (
                <li key={idx} className="flex items-center justify-between border-t py-2">
                  <span className="truncate">{i.name}</span>
                  <span className="tabular-nums">×{i.qty}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border bg-white p-4">
          <h2 className="text-lg font-semibold mb-2">商品別（売上）トップ</h2>
          {metrics.topItemsByGross.length === 0 ? <div className="text-sm text-zinc-600">データがありません。</div> : (
            <ul className="text-sm">
              {metrics.topItemsByGross.map((i, idx) => (
                <li key={idx} className="flex items-center justify-between border-t py-2">
                  <span className="truncate">{i.name}</span>
                  <span className="tabular-nums">{yen(i.gross)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* 簡易AI分析 */}
      <section className="rounded-2xl border bg-white p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">AI 分析（試験版）</h2>
          <button onClick={regenerateInsights} className="rounded-lg border px-3 py-1.5 text-sm bg-white hover:bg-zinc-50">再生成</button>
        </div>
        <ul className="list-disc pl-6 text-sm space-y-1">
          {insights.map((line, i) => (<li key={i}>{line}</li>))}
        </ul>
        <p className="mt-2 text-xs text-zinc-500">TODO(req v2): LLM 連携に置き換え（外部API連携の設定が必要）。</p>
      </section>
    </div >
  );
}

function KPI({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border bg-white p-4">
      <div className="text-sm text-zinc-600">{title}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {note ? <div className="text-xs text-zinc-500">{note}</div> : null}
    </div>
  );
}
