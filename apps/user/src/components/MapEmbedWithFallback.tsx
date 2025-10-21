"use client";

import React from "react";
import { isLiffEnv } from "@/lib/isLiffEnv";

type Props = {
  src: string;
  title?: string;
  className?: string;
  // フォールバック静的画像生成のための座標（任意）
  lat?: number | null;
  lng?: number | null;
  // 「Google マップで開く」のラベルに使用（任意）
  label?: string | null;
  heightClass?: string; // 例: "h-60 md:h-80"
};

const FALLBACK_MS = Number(process.env.NEXT_PUBLIC_MAP_FALLBACK_TIMEOUT_MS || 2500);

export default function MapEmbedWithFallback({ src, title, className = "", lat, lng, label, heightClass = "h-60 md:h-80" }: Props) {
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [useFallback, setUseFallback] = React.useState(false);

  const li = isLiffEnv();

  React.useEffect(() => {
    if (!li) return; // 通常ブラウザはそのまま
    if (loaded || failed) return;
    const id = setTimeout(() => {
      // LIFF で iframe 読み込みが進まない場合にのみフォールバック
      setUseFallback(true);
    }, Math.max(800, FALLBACK_MS));
    return () => clearTimeout(id);
  }, [li, loaded, failed]);

  const openExternal = React.useCallback(() => {
    const q = (lat != null && lng != null) ? `${lat},${lng}` : undefined;
    const url = q ? `https://www.google.com/maps/search/?api=1&query=${q}` : src.replace("/maps/embed", "/maps");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liffObj = (typeof window !== "undefined" ? (window as any).liff : undefined);
    if (liffObj && typeof liffObj.openWindow === "function") {
      try {
        liffObj.openWindow({ url, external: true });
        return;
      } catch { /* noop */ }
    }
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  }, [src, lat, lng]);

  // 失敗/フォールバック: 静的画像 + 外部で開くボタン
  if (li && (useFallback || failed)) {
    const q = (lat != null && lng != null) ? `lat=${lat}&lng=${lng}` : "";
    const imgSrc = q ? `/api/maps-static?${q}&zoom=16&size=800x480` : undefined;
    return (
      <div className={["relative mt-2 rounded-xl overflow-hidden border touch-pan-y touch-pinch-zoom overscroll-contain", className].join(" ")}
           aria-label={title || "地図"}>
        {imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc} alt={title || "地図"} className={["w-full object-cover", heightClass].join(" ")} />
        ) : (
          <div className={["w-full bg-zinc-100 flex items-center justify-center text-sm text-zinc-600", heightClass].join(" ")}>
            地図を読み込めませんでした
          </div>
        )}

        <div className="absolute right-2 bottom-2">
          <button
            type="button"
            onClick={openExternal}
            className="px-2 py-1 rounded bg-white/95 hover:bg-white border text-[12px] shadow"
          >
            Google マップで開く
          </button>
        </div>
      </div>
    );
  }

  // 既定: そのまま iframe を表示
  return (
    <div className={["relative mt-2 rounded-xl overflow-hidden border touch-pan-y touch-pinch-zoom overscroll-contain", className].join(" ")}>
      <iframe
        className={["w-full", heightClass].join(" ")}
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        title={title || "地図"}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{ pointerEvents: "auto" }}
      />
    </div>
  );
}

