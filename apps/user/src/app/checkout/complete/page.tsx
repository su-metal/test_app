"use client";
import { useEffect } from "react";

export default function CheckoutCompleteRedirect() {
  useEffect(() => {
    // 既存: /checkout/complete?session_id=... → /checkout/success へ移動
    const search = typeof window !== "undefined" ? window.location.search : "";

    // 「完了経由」を後工程（success / home）で判定できるよう二重フラグをセット
    try {
      sessionStorage.setItem("afterCheckoutComplete", "1");
    } catch { }

    // 元のクエリにフラグを足す
    const hasQuery = !!search && search.length > 0;
    const join = hasQuery ? "&" : "?";
    const next = `/checkout/success${search}${join}fromComplete=1`;

    // 履歴に残さない置換遷移（戻るで /complete に戻さない）
    window.location.replace(next);
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
