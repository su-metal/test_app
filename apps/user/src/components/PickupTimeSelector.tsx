// apps/user/src/components/PickupTimeSelector.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

type Preset = {
    slot_no: number;
    name: string;          // 例: "通常"
    start_time: string;    // "HH:MM:SS"
    end_time: string;      // "HH:MM:SS"
    slot_minutes: number;  // 10
};

export type PickupSlot = { label: string; start: string; end: string };

// ---- 時刻ユーティリティ（JST基準） ----
const TZ = "Asia/Tokyo";

/** "HH:MM" → 分（0..1439） */
function hhmmToMinutes(hhmm: string) {
    const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
    return h * 60 + m;
}
/** 分 → "HH:MM" */
function minutesToHHmm(mins: number) {
    const h = String(Math.floor(mins / 60)).padStart(2, "0");
    const m = String(mins % 60).padStart(2, "0");
    return `${h}:${m}`;
}
/** 現在（JST）の "HH","MM" を取り出し minutes で返す */
function nowMinutesJST() {
    const parts = new Intl.DateTimeFormat("ja-JP", {
        timeZone: TZ,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(new Date());
    const hh = Number(parts.find(p => p.type === "hour")?.value || "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value || "0");
    return hh * 60 + mm;
}

export default function PickupTimeSelector(props: {
    storeId: string;
    onSelect: (slot: PickupSlot) => void;
    value?: PickupSlot | null;
    className?: string;
    /** 近すぎ確認の閾値（分）。既定30分 */
    nearThresholdMin?: number;
    /** 受け取り開始の何分前から選べないようにするか（分）。既定20分 */
    leadCutoffMin?: number;
    /** 追加: この分区間だけで候補を生成（例: {start:600,end:840} = 10:00〜14:00） */
    limitWindow?: { start: number; end: number };
    /** 追加: 分刻みの上書き。未指定ならプリセットの slot_minutes を使用 */
    stepOverride?: number;
}) {
    const {
        storeId,
        onSelect,
        value,
        className = "",
        nearThresholdMin = 30,
        leadCutoffMin = 20,
        limitWindow,
        stepOverride,
    } = props;


    const [preset, setPreset] = useState<Preset | null>(null);
    const [allSlots, setAllSlots] = useState<PickupSlot[]>([]);
    const [loading, setLoading] = useState(true);
    // 現在時刻（JST, 分）を保持し、1分ごとに更新
    const [nowMin, setNowMin] = useState(nowMinutesJST());
    useEffect(() => {
        const id = setInterval(() => setNowMin(nowMinutesJST()), 60_000);
        return () => clearInterval(id);
    }, []);
    // 取得 & スロット生成
    const refresh = useCallback(async () => {
        setLoading(true);

        // 先に limitWindow を評価。妥当ならプリセットを参照せず、ここから直接スロット生成
        const hasValidLimit =
            !!limitWindow &&
            Number.isFinite(limitWindow.start) &&
            Number.isFinite(limitWindow.end) &&
            limitWindow.end > limitWindow.start;
        if (hasValidLimit) {
            const start = Math.max(0, Math.floor(limitWindow!.start));
            const end = Math.min(24 * 60, Math.floor(limitWindow!.end));
            const step = stepOverride ?? 10; // プリセットが無くても 10分刻みにフォールバック
            const out: PickupSlot[] = [];
            for (let t = start; t + step <= end; t += step) {
                const s = minutesToHHmm(t);
                const e = minutesToHHmm(t + step);
                out.push({ label: `${s}–${e}`, start: s, end: e });
            }
            setPreset(null);
            setAllSlots(out);
            setLoading(false);
            return;
        }

        const { data: store } = await supabase
            .from("stores")
            .select("current_pickup_slot_no")
            .eq("id", storeId)
            .single();

        if (!store?.current_pickup_slot_no) {
            setPreset(null);
            setAllSlots([]);
            setLoading(false);
            return;
        }

        const { data: presets } = await supabase
            .from("store_pickup_presets")
            .select("slot_no,name,start_time,end_time,slot_minutes")
            .eq("store_id", storeId)
            .eq("slot_no", store.current_pickup_slot_no)
            .limit(1);

        const p = (presets?.[0] as Preset) || null;
        setPreset(p);

        if (p) {
            const start = hhmmToMinutes(p.start_time);
            const end = hhmmToMinutes(p.end_time);
            const step = stepOverride ?? p.slot_minutes;
            const out: PickupSlot[] = [];
            for (let t = start; t + step <= end; t += step) {
                const s = minutesToHHmm(t);
                const e = minutesToHHmm(t + step);
                out.push({ label: `${s}–${e}`, start: s, end: e });
            }
            setAllSlots(out);
        } else {
            setAllSlots([]);
        }

        setLoading(false);
    }, [storeId, stepOverride, limitWindow]);

    useEffect(() => { refresh(); }, [refresh]);

    // Realtime: プリセット/現在スロットの変更で即時反映
    // TODO(req v2): 差分適用に最適化（現在はフル再取得）
    useEffect(() => {
        const ch1 = supabase
            .channel(`rt-pickup-selector-presets:${storeId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'store_pickup_presets', filter: `store_id=eq.${storeId}` }, () => {
                refresh();
            })
            .subscribe();

        const ch2 = supabase
            .channel(`rt-pickup-selector-store:${storeId}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'stores', filter: `id=eq.${storeId}` }, () => {
                refresh();
            })
            .subscribe();

        // フェールセーフの軽いポーリング（Realtime 不達時の整合性担保）
        const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 15000);
        const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
        document.addEventListener('visibilitychange', onVis);

        return () => {
            try { supabase.removeChannel(ch1); } catch { }
            try { supabase.removeChannel(ch2); } catch { }
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [storeId, refresh]);

    // ==== グループの共通交差（分）で絞り込み（指定があるときだけ適用） ====
    const windowedSlots = useMemo(() => {
        if (!limitWindow || !(limitWindow.end > limitWindow.start)) return allSlots;
        const smin = Math.max(0, limitWindow.start);
        const emin = Math.min(24 * 60, limitWindow.end);
        return allSlots.filter(s => {
            const st = hhmmToMinutes(s.start);
            const en = hhmmToMinutes(s.end);
            return st >= smin && en <= emin; // 完全に内側のスロットだけ許可
        });
    }, [allSlots, limitWindow]);


    // ==== 現在以降に限定（JST） ====
    const futureSlots = useMemo(() => {
        const gate = nowMin + leadCutoffMin;
        return windowedSlots.filter(s => hhmmToMinutes(s.start) >= gate);
    }, [windowedSlots, nowMin, leadCutoffMin]);

    const displayPresetName = useMemo(
        () => preset?.name ?? (limitWindow ? "共通枠" : "—"),
        [preset?.name, limitWindow]
    );

    // ==== 「時 → 分」グルーピング ====
    const groups = useMemo(() => {
        const g = new Map<string, PickupSlot[]>();
        for (const s of futureSlots) {
            const hh = s.start.slice(0, 2);
            if (!g.has(hh)) g.set(hh, []);
            g.get(hh)!.push(s);
        }
        return g;
    }, [futureSlots]);

    // 初期選択の“時”は、value が今以降ならその時、なければ最初の時
    const initialHour = useMemo(() => {
        const vv = value?.start ? hhmmToMinutes(value.start) : null;
        if (vv != null && futureSlots.some(s => s.start === value!.start)) {
            return value!.start.slice(0, 2);
        }
        const it = groups.keys().next();
        return it.done ? null : it.value;
    }, [groups, futureSlots, value?.start]);

    const [hour, setHour] = useState<string | null>(initialHour);
    useEffect(() => { setHour(initialHour); }, [initialHour]);

    const hours = useMemo(() => Array.from(groups.keys()), [groups]);
    const minutes = useMemo(() => (hour ? groups.get(hour) ?? [] : []), [groups, hour]);

    // ==== 近すぎ確認（選択時） ====
    const handleSelect = (s: PickupSlot) => {
        const nowMin = nowMinutesJST();
        const startMin = hhmmToMinutes(s.start);
        const delta = startMin - nowMin; // 分（state由来）
        if (delta < leadCutoffMin) {
            alert(`受け取りまで${delta < 0 ? 0 : delta}分です。直近枠は選べません（${leadCutoffMin}分前まで）。`);
            return;
        }
        if (delta < nearThresholdMin) {
            const ok = window.confirm(`受け取りまで ${delta} 分です。時間に余裕はありますか？`);
            if (!ok) return;
        }
        onSelect(s);
    };

    // UI helpers（横スクロール：省スペース）
    const hourRailRef = useRef<HTMLDivElement | null>(null);
    const minRailRef = useRef<HTMLDivElement | null>(null);
    const scrollRail = (ref: React.RefObject<HTMLDivElement | null>, dir: "prev" | "next") => {
        const rail = ref.current;
        if (!rail) return;
        const delta = Math.floor(rail.clientWidth * 0.9) * (dir === "next" ? 1 : -1);
        rail.scrollBy({ left: delta, behavior: "smooth" });
    };

    if (loading) return <div className={`text-xs text-zinc-500 ${className}`}>受取時間を読み込み中…</div>;
    if (allSlots.length === 0) return <div className={`text-xs text-zinc-500 ${className}`}>受取時間の候補がありません。</div>;
    if (futureSlots.length === 0) {

        return (
            <div className={`w-full ${className}`}>
                <div className="mb-1.5 text-sm font-medium">
                    受け取り予定時間 <span className="text-red-500 ml-1">必須</span>
                    <span className="ml-2 text-[11px] text-zinc-500">（{displayPresetName}）</span>
                </div>
                <div className="text-xs text-zinc-500">本日の受け取り可能時間は終了しました。</div>
            </div>
        );
    }

    const hasHourScroll = hours.length > 6;
    const hasMinScroll = minutes.length > 6;

    return (
        <div className={`w-full ${className}`}>
            {/* ラベル行 */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="text-sm font-medium">
                    受け取り予定時間 <span className="text-red-500 ml-1">必須</span>
                    <span className="ml-2 text-[11px] text-zinc-500">（{displayPresetName}）</span>
                </div>
            </div>

            {/* Row 1: 時 */}
            <div className="flex items-center gap-1 mb-2">
                {hasHourScroll && (
                    <button
                        type="button"
                        className="h-7 px-2 rounded-md border text-xs bg-white hover:bg-zinc-50"
                        onClick={() => scrollRail(hourRailRef, "prev")}
                        aria-label="前の時間"
                    >
                        ‹
                    </button>
                )}
                <div
                    ref={hourRailRef}
                    className="flex-1 flex gap-2 overflow-x-auto scroll-p-2"
                    style={{ scrollbarWidth: "none" } as any}
                >
                    {hours.map((h) => {
                        const selected = hour === h;
                        return (
                            <button
                                key={h}
                                type="button"
                                onClick={() => setHour(h)}
                                aria-pressed={selected}
                                className={[
                                    "px-3 py-1.5 rounded-full border text-sm whitespace-nowrap",
                                    selected
                                        ? "bg-zinc-900 text-white border-zinc-900"
                                        : "bg-white text-zinc-800 hover:bg-zinc-50",
                                ].join(" ")}
                            >
                                {h}時
                            </button>
                        );
                    })}
                </div>
                {hasHourScroll && (
                    <button
                        type="button"
                        className="h-7 px-2 rounded-md border text-xs bg-white hover:bg-zinc-50"
                        onClick={() => scrollRail(hourRailRef, "next")}
                        aria-label="次の時間"
                    >
                        ›
                    </button>
                )}
            </div>

            {/* Row 2: 分（選択した“時”のみ、10分刻み） */}
            <div className="flex items-center gap-1">
                {hasMinScroll && (
                    <button
                        type="button"
                        className="h-7 px-2 rounded-md border text-xs bg-white hover:bg-zinc-50"
                        onClick={() => scrollRail(minRailRef, "prev")}
                        aria-label="前の分"
                    >
                        ‹
                    </button>
                )}
                <div
                    ref={minRailRef}
                    className="flex-1 flex gap-2 overflow-x-auto scroll-p-2"
                    style={{ scrollbarWidth: "none" } as any}
                >
                    {minutes.map((s) => {
                        const selected = value?.label === s.label;
                        const minuteLabel = s.start.slice(3, 5); // "00" | "10" ...
                        return (
                            <button
                                key={s.label}
                                type="button"
                                onClick={() => handleSelect(s)}
                                aria-pressed={selected}
                                className={[
                                    "px-3 py-1.5 rounded-full border text-sm whitespace-nowrap",
                                    selected
                                        ? "bg-zinc-900 text-white border-zinc-900"
                                        : "bg-white text-zinc-800 hover:bg-zinc-50",
                                ].join(" ")}
                                title={`${s.start}–${s.end}`}
                            >
                                {hour} : {minuteLabel}
                            </button>
                        );
                    })}
                </div>
                {hasMinScroll && (
                    <button
                        type="button"
                        className="h-7 px-2 rounded-md border text-xs bg-white hover:bg-zinc-50"
                        onClick={() => scrollRail(minRailRef, "next")}
                        aria-label="次の分"
                    >
                        ›
                    </button>
                )}
            </div>
        </div>
    );
}
