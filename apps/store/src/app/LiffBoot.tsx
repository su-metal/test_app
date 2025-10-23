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
                    // 本番の LIFF 既定エンドポイントに流れないよう現在のURLへ戻す
                    const configuredBase = (window as any).BASE_URL_STORE as string | undefined;
                    const { origin, pathname, search } = window.location;
                    const fallback = `${origin}${pathname}${search}`;
                    const inClient = typeof liff.isInClient === 'function' ? liff.isInClient() : false;
                    // BASE_URL_STORE があればそれを優先（正規化して末尾スラッシュ含む）
                    if (configuredBase && configuredBase.length > 0) {
                        try {
                            const u = new URL(configuredBase);
                            u.hash = '';
                            liff.login({ redirectUri: u.toString() });
                        } catch {
                            liff.login({ redirectUri: configuredBase });
                        }
                    } else if (inClient) {
                        // LINEアプリ内なら redirectUri 省略でも戻れる
                        liff.login();
                    } else {
                        // 省略不可の環境ではハッシュを除いた現在URLを使用
                        liff.login({ redirectUri: fallback });
                    }
                } else {
                    if (debug) console.info("[LIFF][store] init done (no auto login)");
                    try {
                        const idToken = liff.getIDToken();
                        if (idToken) {
                            await fetch("/api/auth/line/silent-login", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ id_token: idToken }),
                                credentials: "include",
                            });
                        } else if (debug) {
                            console.info("[LIFF][store] no id token yet");
                        }
                    } catch (e) {
                        if (debug) console.warn("[LIFF][store] silent-login failed", e);
                    }
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
