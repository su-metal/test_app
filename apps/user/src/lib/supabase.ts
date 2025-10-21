"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let __client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!__client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    __client = createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "sb-user-app",
      },
      global: {
        headers: {
          apikey: anon,
          Authorization: `Bearer ${anon}`,
          "x-store-id": process.env.NEXT_PUBLIC_STORE_ID || "",
        },
      },
    });
  }
  return __client;
}

export const supabase = getSupabaseClient();

// TODO(req v2): 必要に応じてログ/メトリクス連携を追加

