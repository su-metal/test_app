"use client";
import React from "react";
import { getLiffIdTokenCached } from "@/lib/liffTokenCache";

type LatestRes = { ok: boolean; order: null | { id: string; code?: string | null } };

function useVisibility() {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

export default function RedeemConfirmWatcher() {
  const [target, setTarget] = React.useState<null | { id: string; code?: string | null }>(null);
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const visible = useVisibility();

  // 監視: 起動/復帰/一定間隔で確認
  React.useEffect(() => {
    let timer: any;
    let disposed = false;
    const load = async () => {
      try {
        const idt = await getLiffIdTokenCached().catch(() => null);
        const headers: Record<string, string> = { };
        if (idt) headers["authorization"] = `Bearer ${idt}`;
        const r = await fetch("/api/orders/redeem-request/latest", { cache: "no-store", headers });
        const j = (await r.json()) as LatestRes;
        if (!disposed && j?.ok && j.order) {
          setTarget(j.order);
          setOpen(true);
        }
      } catch { /* noop */ }
    };
    load();
    timer = setInterval(load, 8000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  React.useEffect(() => {
    if (visible) {
      (async () => {
        const idt = await getLiffIdTokenCached().catch(() => null);
        const headers: Record<string, string> = { };
        if (idt) headers["authorization"] = `Bearer ${idt}`;
        fetch("/api/orders/redeem-request/latest", { cache: "no-store", headers })
          .then(r => r.json())
          .then((j: LatestRes) => { if (j?.ok && j.order) { setTarget(j.order); setOpen(true); } });
      })();
    }
  }, [visible]);

  // スワイプ UI（横ドラッグ）
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const knobRef = React.useRef<HTMLDivElement | null>(null);
  const posRef = React.useRef(0);
  const draggingRef = React.useRef(false);

  const resetKnob = React.useCallback(() => {
    posRef.current = 0;
    const k = knobRef.current; if (k) k.style.transform = `translateX(0px)`;
  }, []);

  const onDown = React.useCallback((ev: React.PointerEvent) => {
    if (submitting) return;
    draggingRef.current = true;
    (ev.target as Element).setPointerCapture(ev.pointerId);
  }, [submitting]);
  const onMove = React.useCallback((ev: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const track = trackRef.current; const k = knobRef.current;
    if (!track || !k) return;
    const rect = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width - k.offsetWidth, ev.clientX - rect.left - k.offsetWidth / 2));
    posRef.current = x;
    k.style.transform = `translateX(${x}px)`;
  }, []);
  const onUp = React.useCallback(async () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const track = trackRef.current; const k = knobRef.current;
    if (!track || !k || !target) return resetKnob();
    const passed = posRef.current > (track.clientWidth - k.offsetWidth) * 0.85;
    if (!passed) return resetKnob();
    // 確定
    setSubmitting(true);
    try {
      const idt = await getLiffIdTokenCached().catch(() => null);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (idt) headers["authorization"] = `Bearer ${idt}`;
      const r = await fetch("/api/orders/redeem", {
        method: "POST",
        headers,
        body: JSON.stringify({ orderId: target.id })
      });
      const j = await r.json();
      if (j?.ok) {
        setOpen(false); setTarget(null);
      } else {
        // エラー時は開いたまま
        console.error("[redeem] failed:", j?.error || r.status);
        resetKnob();
      }
    } catch (e) {
      console.error("[redeem] fatal:", (e as any)?.message ?? e);
      resetKnob();
    } finally {
      setSubmitting(false);
    }
  }, [target, resetKnob]);

  if (!open || !target) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-end sm:place-items-center bg-black/30" role="dialog" aria-modal="true">
      <div className="w-full sm:max-w-md sm:mb-24 rounded-t-2xl sm:rounded-2xl bg-white shadow-xl p-5">
        <div className="text-base font-semibold">受取りを確定しますか？</div>
        <div className="mt-1 text-sm text-zinc-600">店舗が受け渡しを開始しました。スワイプで確定すると、引換済みに更新されます。</div>
        <div className="mt-2 text-xs text-zinc-500">注文ID: {target.id}</div>

        <div className="mt-4">
          <div
            ref={trackRef}
            className={`relative w-full h-12 rounded-full ${submitting ? 'bg-emerald-600/10' : 'bg-zinc-100'} select-none overflow-hidden`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            <div className="absolute inset-0 grid place-items-center pointer-events-none text-sm text-zinc-600">
              {submitting ? '確定しました' : '右にスワイプして確定'}
            </div>
            <div
              ref={knobRef}
              className={`absolute top-1 left-1 h-10 w-28 rounded-full ${submitting ? 'bg-emerald-600' : 'bg-zinc-900'} text-white grid place-items-center text-sm`}
            >
              {submitting ? '確定中…' : 'スワイプ'}
            </div>
          </div>

          <div className="mt-3 text-[11px] text-zinc-500">操作が難しい場合は、下のボタンでも確定できます。</div>
          <div className="mt-2">
            <button
              className="w-full rounded-xl bg-zinc-900 text-white py-2.5 text-sm font-medium disabled:opacity-60"
              disabled={submitting}
              onClick={() => onUp()}
            >受取りを確定する</button>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button className="text-sm text-zinc-600 underline" onClick={() => { setOpen(false); setTarget(null); }}>あとで</button>
        </div>
      </div>
    </div>
  );
}
