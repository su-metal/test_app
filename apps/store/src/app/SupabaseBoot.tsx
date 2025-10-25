"use client";
import { useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

export default function SupabaseBoot() {
    useEffect(() => {
        // 1) env を window にブリッジ（SSR/CSR 共通）
        if (!window.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
            window.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
        }
        if (!window.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
            window.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
        }

        // 2) サーバーセッションから店舗IDを取得し __STORE_ID__ に反映（localStorage 依存を撤廃）
        (async () => {
            try {
                const r = await fetch("/api/auth/session/inspect", { cache: "no-store" });
                const j = await r.json().catch(() => ({} as any));
                const sid = (r.ok && typeof j?.store_id === "string") ? (j.store_id as string).trim() : "";
                window.__STORE_ID__ = sid || undefined;

                try {
                    const keys = ["store:selected", "storeId"];
                    for (const k of keys) {
                        const v = localStorage.getItem(k);
                        if (v === "" || v === "null" || v === "undefined") localStorage.removeItem(k);
                    }
                } catch { }
            } catch {
                window.__STORE_ID__ = undefined;
            }
        })();

        // 3) Supabase クライアントの単一生成
        if (!window.__supabase) {
            const url = window.NEXT_PUBLIC_SUPABASE_URL;
            const key = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
            if (url && key) {
                try {
                    window.__supabase = createClient(url, key);
                } catch { }
            }
        }
    }, []);

    return null;
}
