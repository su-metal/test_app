"use client";
import { useEffect } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare global {
    interface Window {
        __supabase?: SupabaseClient<any>;
        __STORE_ID__?: string;
        NEXT_PUBLIC_SUPABASE_URL?: string;
        NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
        NEXT_PUBLIC_STORE_ID?: string;
    }
}

export default function SupabaseBoot() {
    useEffect(() => {
        // 1) env → window へ載せる（App RouterのSSR/CSR差吸収用）
        if (!window.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
            window.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
        }
        if (!window.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
            window.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
        }
        // 選択済みの店舗IDを localStorage から反映（env へはフォールバックしない）
        try {
            const saved = typeof window !== 'undefined' ? localStorage.getItem('store:selected') : null;
            if (saved) {
                window.__STORE_ID__ = saved;
            }
        } catch {
            /* noop */
        }

        // 2) Supabase クライアントを一度だけ生成して保持
        if (!window.__supabase) {
            const url = window.NEXT_PUBLIC_SUPABASE_URL;
            const key = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
            if (url && key) {
                try { window.__supabase = createClient(url, key); } catch { }
            }
        }
    }, []);

    return null;
}
