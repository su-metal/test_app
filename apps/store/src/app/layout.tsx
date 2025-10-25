// apps/store/src/app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SupabaseBoot from "./SupabaseBoot";
import StoreGuard from "./StoreGuard";

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
                  // env ブリッジ（店舗IDはここでは設定しない）
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = null;
                } catch(e) {
                  window.NEXT_PUBLIC_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
                  window.NEXT_PUBLIC_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseKey)};
                  window.__SUPABASE_URL__ = window.NEXT_PUBLIC_SUPABASE_URL;
                  window.__SUPABASE_ANON_KEY__ = window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                  window.__STORE_ID__ = null;
                }
              })();
            `,
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <SupabaseBoot />
        {/* ガードで localStorage フォールバックを反映 */}
        <StoreGuard />
        {children}
      </body>
    </html>
  );
}

