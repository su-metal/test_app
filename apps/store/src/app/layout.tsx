// apps/store/src/app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import SupabaseBoot from "./SupabaseBoot";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "店舗アプリ",
  description: "フードロス店舗アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  return (
    <html lang="ja">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                try {
                  var saved = null;
                  try { saved = localStorage.getItem('store:selected'); } catch {}
                  // 共有キー（store/user 両アプリで利用）
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  // 互換エイリアス（環境変数コード対応）。店舗IDはセッションを正とするためenvには載せない
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = saved || '';
                } catch(e) {
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = '';
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

