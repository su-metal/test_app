import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
// 先頭の他の import の下あたりに追加
import SupabaseBoot from "./SupabaseBoot";


const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "店舗アプリ",
  description: "フードロス店舗アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // サーバー側で .env の公開値を window にブリッジ
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const storeId = process.env.NEXT_PUBLIC_STORE_ID ?? "";

  return (
    <html lang="ja">
      <head>
        {/* favicon */}
        <link rel="icon" href="/favicon.ico" />

        {/* 必要なら他の meta/link もここに */}

        {/* 公開用の環境変数を window に渡す（クライアントで useSupabase が拾う） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                try {
                  var saved = null;
                  try { saved = localStorage.getItem('store:selected'); } catch {}
                  // 正式キー（store/user 両アプリで統一）
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  window.NEXT_PUBLIC_STORE_ID = saved || ${JSON.stringify(storeId)};

                  // 互換エイリアス（既存コード対策）
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = window.NEXT_PUBLIC_STORE_ID;
                } catch(e) {
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  window.NEXT_PUBLIC_STORE_ID = ${JSON.stringify(storeId)};
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = window.NEXT_PUBLIC_STORE_ID;
                }
              })();
            `,
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <SupabaseBoot />
        {children}
      </body>
    </html>
  );
}
