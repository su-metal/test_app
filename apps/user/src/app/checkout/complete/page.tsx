"use client";
import { useEffect } from "react";

export default function CheckoutCompleteRedirect() {
  useEffect(() => {
    // 既存のフロー互換: /checkout/complete?session_id=... → /checkout/success へ移動
    // TODO(req v2): 必要に応じて完了ページ専用の検証UIを実装
    const search = typeof window !== "undefined" ? window.location.search : "";
    window.location.replace(`/checkout/success${search}`);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-center space-y-4">
        <h1 className="text-lg font-semibold">リダイレクト中…</h1>
        <p className="text-sm text-zinc-600">ページを移動しています。</p>
        <noscript>
          <p className="text-sm text-red-600">JavaScriptを有効にしてください。</p>
        </noscript>
      </div>
    </main>
  );
}

