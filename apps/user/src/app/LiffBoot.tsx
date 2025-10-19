"use client";

import { useEffect } from "react";
import { ensureLiffInitialized, loginIfNeeded } from "@/lib/liffClient";

/**
 * LIFF ブートコンポーネント（安全設計）
 *
 * - ローカル/開発フラグ時は LIFF を完全スキップ（UIの挙動確認を阻害しない）
 *   - 条件: hostname が 'localhost' または NEXT_PUBLIC_DEV_SKIP_LIFF === '1'
 * - 本番/検証環境では liff.init() だけ実行
 *   - 既定で自動ログイン（NEXT_PUBLIC_LIFF_AUTO_LOGIN='0' で無効化）
 * - NEXT_PUBLIC_DEBUG='1' で初期化ログを出します
 *
 * 必要な環境変数（本番/検証）:
 *   - NEXT_PUBLIC_LIFF_ID               ... LIFF ID（例: 2008314807-xxxxxx）
 * オプション:
 *   - NEXT_PUBLIC_DEV_SKIP_LIFF='1'     ... ローカルなどで LIFF を強制スキップ
 *   - NEXT_PUBLIC_LIFF_AUTO_LOGIN='0'   ... 自動ログインを無効化（既定は有効）
 *   - NEXT_PUBLIC_DEBUG='1'             ... デバッグログを出力
 */
export default function LiffBoot() {
  useEffect(() => {
    let mounted = true;

    // --- 1) ローカル/開発フラグ時は何もしない ---
    const isLocalhost =
      typeof window !== "undefined" && location.hostname === "localhost";
    const skipLiff = process.env.NEXT_PUBLIC_DEV_SKIP_LIFF === "1";

    if (isLocalhost || skipLiff) {
      if (process.env.NEXT_PUBLIC_DEBUG === "1") {
        console.info("[LIFF] skipped (localhost or DEV_SKIP flag)");
      }
      return;
    }

    // --- 2) 本番/検証: LIFF 初期化 → 任意で自動ログイン ---
    (async () => {
      try {
        const debug = process.env.NEXT_PUBLIC_DEBUG === "1";
        const autoLogin = process.env.NEXT_PUBLIC_LIFF_AUTO_LOGIN !== "0";

        // あなたの liffClient 実装がオプションオブジェクトを受け取れる想定
        // （受け取らない実装でも追加プロパティは無視されます）
        const opts: Partial<{ debug: boolean; liffId: string }> = {
          debug,
        };
        if (process.env.NEXT_PUBLIC_LIFF_ID) {
          opts.liffId = process.env.NEXT_PUBLIC_LIFF_ID!;
        }

        await ensureLiffInitialized(opts);

        if (autoLogin) {
          await loginIfNeeded();
        }

        if (debug && mounted) console.info("[LIFF] boot ok");
      } catch (err) {
        if (mounted) console.error("[LIFF] 初期化に失敗しました:", err);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return null;
}
