"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function SuccessPage() {
  const [msg, setMsg] = useState("処理中です…");
  const router = useRouter();
  // success/page.tsx 内の「アプリへ戻る」ボタン onClick
  const backToHome = () => {
    try { sessionStorage.setItem("came_from_checkout", "1"); } catch { }
    // 履歴を残さない
    if (typeof window !== "undefined") {
      window.location.replace("/?came_from_checkout=1");
    }
    // Next.js の Router を使うなら:
    // const router = useRouter();
    // router.replace('/?came_from_checkout=1');
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const session_id = url.searchParams.get("session_id");
    if (!session_id) {
      setMsg("セッションIDが見つかりません");
      return;
    }

    (async () => {
      try {
        const res = await fetch(
          `/api/stripe/fulfill?session_id=${encodeURIComponent(session_id)}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (!res.ok || !json?.order) {
          throw new Error(json?.error || "fulfill failed");
        }
        // ローカル（orders）に追加（簡易整合用）
        const key = "orders";
        const prev = JSON.parse(localStorage.getItem(key) || "[]");
        localStorage.setItem(key, JSON.stringify([json.order, ...prev]));

        // 決済完了した商品をカートから除去（startStripeCheckout で保存した購入対象を参照）
        try {
          const raw = sessionStorage.getItem("checkout_group_itemKeys");
          if (raw) {
            const itemKeys: string[] = JSON.parse(raw);
            const cartRaw = localStorage.getItem("cart");
            const cartArr: any[] = cartRaw ? JSON.parse(cartRaw) : [];
            const filtered = (Array.isArray(cartArr) ? cartArr : []).filter(
              (l: any) => !itemKeys.includes(`${l?.shopId}:${l?.item?.id}`)
            );
            localStorage.setItem("cart", JSON.stringify(filtered));
          }
        } catch {
          /* noop */
        }
        // 後始末
        try {
          sessionStorage.removeItem("checkout_target_group");
          sessionStorage.removeItem("checkout_group_itemKeys");
        } catch {
          /* noop */
        }

        // 完了メッセージ
        setMsg("ご購入ありがとうございました。チケットを追加し、カートを更新しました。");
      } catch (e: any) {
        console.error(e);
        setMsg(
          "決済は完了していますが、処理に失敗しました。アプリに戻ってご確認ください。"
        );
      }
    })();
  }, []);

  // 「アプリへ戻る」：履歴を残さずホームへ + ホーム側で戻る=終了にするためのフラグ設定
  const handleBackToApp = useCallback(() => {
    try {
      // ホーム側のガードを一度だけ有効化するためのフラグ
      sessionStorage.setItem("afterCheckoutComplete", "1");
    } catch { }

    // 履歴置換で完了画面に戻れないようにする（ホーム側は ?postComplete=1 を見てガード）
    router.replace("/?postComplete=1");
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-center space-y-4">
        <h1 className="text-lg font-semibold">決済完了</h1>
        <p className="text-sm text-zinc-600">{msg}</p>

        {/* a要素→buttonへ変更し、onClickで履歴置換＆フラグ付与 */}
        <button
          type="button"
          onClick={handleBackToApp}
          className="inline-block px-4 py-2 rounded-xl border bg-zinc-900 text-white"
        >
          アプリに戻る
        </button>
      </div>
    </main>
  );
}
