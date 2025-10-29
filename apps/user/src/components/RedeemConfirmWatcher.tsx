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
        const headers: Record<string, string> = {};
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
        const headers: Record<string, string> = {};
        if (idt) headers["authorization"] = `Bearer ${idt}`;
        fetch("/api/orders/redeem-request/latest", { cache: "no-store", headers })
          .then(r => r.json())
          .then((j: LatestRes) => { if (j?.ok && j.order) { setTarget(j.order); setOpen(true); } });
      })();
    }
  }, [visible]);

  // スワイプ UI（横ドラッグ） — rAF/計測キャッシュでスムーズに
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const knobRef = React.useRef<HTMLDivElement | null>(null);

  // 計測キャッシュ
  const maxXRef = React.useRef(0);      // つまみが移動できる最大X
  const draggingRef = React.useRef(false);

  // 描画更新用
  const pendingXRef = React.useRef<number | null>(0);
  const rafRef = React.useRef<number | null>(null);
  const transitionEnabledRef = React.useRef(true);

  const setKnobTransform = (x: number) => {
    const k = knobRef.current;
    if (!k) return;
    // GPU向けに translate3d を使用
    k.style.transform = `translate3d(${x}px,0,0)`;
  };

  const disableTransition = () => {
    if (!transitionEnabledRef.current) return;
    transitionEnabledRef.current = false;
    const k = knobRef.current;
    if (k) k.style.transition = "none";
  };
  const enableTransition = () => {
    if (transitionEnabledRef.current) return;
    transitionEnabledRef.current = true;
    const k = knobRef.current;
    if (k) k.style.transition = "transform 200ms ease-out";
  };

  const resetKnob = React.useCallback(() => {
    enableTransition();
    setKnobTransform(0);
  }, []);

  const flushRaf = () => {
    rafRef.current = null;
    const x = pendingXRef.current;
    if (x == null) return;
    pendingXRef.current = null;
    setKnobTransform(x);
  };

  const scheduleRaf = () => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flushRaf);
  };

  const measureOnce = () => {
    const track = trackRef.current;
    const k = knobRef.current;
    if (!track || !k) return;
    // pointerdown 時に1回だけ計測
    const trackW = track.clientWidth; // reflowコスト低
    const knobW = k.offsetWidth;
    maxXRef.current = Math.max(0, trackW - knobW);
  };

  const onDown = React.useCallback((ev: React.PointerEvent) => {
    if (submitting) return;
    draggingRef.current = true;
    measureOnce();
    disableTransition();
    (ev.target as Element).setPointerCapture(ev.pointerId);
  }, [submitting]);

  const onMove = React.useCallback((ev: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const track = trackRef.current;
    const k = knobRef.current;
    if (!track || !k) return;
    const rectLeft = track.getBoundingClientRect().left; // 位置だけ参照（幅は pointerdown 測定済み）
    const half = k.offsetWidth / 2; // これもコスト低い
    const raw = ev.clientX - rectLeft - half;
    const x = Math.max(0, Math.min(maxXRef.current, raw));
    pendingXRef.current = x;
    scheduleRaf();
  }, []);

  const onUp = React.useCallback(async (_ev?: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;

    const k = knobRef.current;
    if (!k) return resetKnob();

    const passed = (pendingXRef.current ?? 0) > maxXRef.current * 0.85;

    if (!passed) {
      return resetKnob();
    }

    // 確定
    setSubmitting(true);
    enableTransition(); // 最終到達のアニメを効かせる
    setKnobTransform(maxXRef.current);

    try {
      const idt = await getLiffIdTokenCached().catch(() => null);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (idt) headers["authorization"] = `Bearer ${idt}`;
      const r = await fetch("/api/orders/redeem", {
        method: "POST",
        headers,
        body: JSON.stringify({ orderId: target!.id }),
      });
      const j = await r.json();
      if (j?.ok) {
        setOpen(false);
        setTarget(null);
      } else {
        console.error("[redeem] failed:", j?.error || r.status);
        resetKnob();
      }
    } catch (e) {
      console.error("[redeem] fatal:", (e as any)?.message ?? e);
      resetKnob();
    } finally {
      setSubmitting(false);
    }
  }, [resetKnob, target]);


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
            className={`relative w-full h-12 rounded-full ${submitting ? 'bg-emerald-600/10' : 'bg-zinc-100'} 
              select-none touch-none overflow-hidden`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={() => {
              // つまみの外に出た場合も終了扱い（ユーザー体験を安定させる）
              if (draggingRef.current) onUp();
            }}


          >
            <div className="absolute inset-0 grid place-items-center pointer-events-none text-sm text-zinc-600">
              {submitting ? '確定しました' : '右にスワイプして確定'}
            </div>
            <div
              ref={knobRef}
              // 初期は transition 有効。ドラッグ開始で JS が一時的に切ります。
              className={`absolute top-1 left-1 h-10 w-28 rounded-full ${submitting ? 'bg-emerald-600' : 'bg-zinc-900'} 
                text-white grid place-items-center text-sm will-change-[transform]`}
              style={{ transition: "transform 200ms ease-out" }}
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
