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
                const r = await fetch('/api/auth/session/inspect', { cache: 'no-store' });
                const j = await r.json().catch(() => ({} as any));
                if (r.ok && typeof j?.store_id === 'string') {
                    window.__STORE_ID__ = j.store_id || '';
                } else {
                    window.__STORE_ID__ = '';
                }
            } catch { window.__STORE_ID__ = ''; }
        })();

        // 3) Supabase クライアントの単一生成
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

