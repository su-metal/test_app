// apps/store/src/types/window.supabase.d.ts
export {};

declare global {
  interface Window {
    // Supabase / env ブリッジ（layout.tsx 由来）
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
    NEXT_PUBLIC_STORE_ID?: string;

    // 互換エイリアス（既存コード対策）
    __SUPABASE_URL__?: string;
    __SUPABASE_ANON_KEY__?: string;
    __STORE_ID__?: string;

    // キャッシュ済みクライアント
    __supabase?: import("@supabase/supabase-js").SupabaseClient<any>;
  }
}

