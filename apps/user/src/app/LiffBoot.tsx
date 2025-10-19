"use client";

import { useEffect } from "react";
import { ensureLiffInitialized, loginIfNeeded } from "@/lib/liffClient";

/**
 * LIFF の初期化を行うクライアント専用ブートコンポーネント。
 * - LINE アプリ外で未ログインの場合は login() を実行
 * - デバッグ: NEXT_PUBLIC_DEBUG=1 で初期化ログを出力
 */
export default function LiffBoot() {
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const debug = process.env.NEXT_PUBLIC_DEBUG === '1';
        await ensureLiffInitialized({ debug });
        await loginIfNeeded();
        if (debug && mounted) console.info('[LIFF] boot ok');
      } catch (err) {
        if (mounted) console.error('[LIFF] 初期化に失敗しました:', err);
      }
    })();
    return () => { mounted = false; };
  }, []);
  return null;
}

