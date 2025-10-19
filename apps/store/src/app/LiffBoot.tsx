"use client";

import { useEffect } from "react";
import liff from "@line/liff";

/**
 * 店舗アプリ用 LiffBoot（全文置き換え）
 * - localhost/DEV_SKIP ではLIFFをスキップ
 * - 本番/プレビューでは liff.init()
 * - LINEアプリ内(WebView)のみ自動ログイン
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

        if (isLocalhost || skip) {
            if (debug) console.info("[LIFF][store] skipped (localhost/DEV_SKIP)");
            return;
        }

        (async () => {
            try {
                const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
                if (!liffId) {
                    console.warn("[LIFF][store] NEXT_PUBLIC_LIFF_ID is empty");
                    return;
                }
                await liff.init({ liffId });
                if (!mounted) return;

                if (isLineWebView && !liff.isLoggedIn()) {
                    if (debug) console.info("[LIFF][store] login (LINE WebView)");
                    liff.login();
                } else if (debug) {
                    console.info("[LIFF][store] init done (no auto login)");
                }
            } catch (e) {
                if (mounted) console.error("[LIFF][store] init/login failed", e);
            }
        })();

        return () => {
            mounted = false;
        };
    }, []);

    return null;
}
