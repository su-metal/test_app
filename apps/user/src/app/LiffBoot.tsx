"use client";

import { useEffect } from "react";
import liff from "@line/liff";

/**
 * LiffBoot.tsx（全文置き換え版）
 *
 * 目的：
 *  - ローカルや開発フラグ時は LIFF をスキップして通常開発を快適に
 *  - 本番/プレビューでは LIFF を初期化
 *  - LINE アプリ内(WebView)のときだけ自動で LINE ログインを実行
 *  - 外部ブラウザ（PC/Safari/Chrome）では自動ログインさせない
 *
 * 必要な環境変数：
 *  - NEXT_PUBLIC_LIFF_ID                … 例: 2008314807-xxxxxx
 * 任意の環境変数：
 *  - NEXT_PUBLIC_DEV_SKIP_LIFF=1        … ローカル等で LIFF を完全スキップ
 *  - NEXT_PUBLIC_DEBUG=1                … デバッグログ出力
 */
export default function LiffBoot() {
  useEffect(() => {
    let mounted = true;

    const debug = process.env.NEXT_PUBLIC_DEBUG === "1";
    const isLocalhost =
      typeof window !== "undefined" && location.hostname === "localhost";
    const skip = process.env.NEXT_PUBLIC_DEV_SKIP_LIFF === "1";
    const isLineWebView =
      typeof navigator !== "undefined" && /Line/i.test(navigator.userAgent);

    // 1) ローカル or 明示スキップ → 何もしない
    if (isLocalhost || skip) {
      if (debug) console.info("[LIFF] skipped (localhost or DEV_SKIP flag)");
      return;
    }

    // 2) 本番/プレビュー：LIFF 初期化
    (async () => {
      try {
        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) {
          console.warn("[LIFF] NEXT_PUBLIC_LIFF_ID is empty. Skip init.");
          return;
        }

        await liff.init({ liffId });
        if (!mounted) return;

        if (debug) console.info("[LIFF] init done", { isLineWebView });

        // 3) 自動ログインは「LINE アプリ内のみ」
        if (isLineWebView && !liff.isLoggedIn()) {
          if (debug) console.info("[LIFF] login (LINE WebView)");
          liff.login();
        } else if (debug) {
          console.info(
            "[LIFF] auto login suppressed (external browser or already logged in)"
          );
        }
      } catch (err) {
        if (mounted) console.error("[LIFF] init/login failed:", err);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return null;
}
