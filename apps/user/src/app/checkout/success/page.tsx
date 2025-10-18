"use client";
import { useEffect, useState } from "react";

export default function SuccessPage() {
    const [msg, setMsg] = useState("処理中…");

    useEffect(() => {
        const url = new URL(window.location.href);
        const session_id = url.searchParams.get("session_id");
        if (!session_id) { setMsg("セッションが見つかりません"); return; }

        (async () => {
            try {
                const res = await fetch(`/api/stripe/fulfill?session_id=${encodeURIComponent(session_id)}`, { cache: "no-store" });
                const json = await res.json();
                if (!res.ok || !json?.order) {
                    throw new Error(json?.error || "fulfill failed");
                }
                // ローカル履歴（orders）へ追加（元のローカルStorageキーに合わせて保存）
                const key = "orders";
                const prev = JSON.parse(localStorage.getItem(key) || "[]");
                localStorage.setItem(key, JSON.stringify([json.order, ...prev]));
                setMsg("支払いが完了しました。チケットを追加しました。");
            } catch (e: any) {
                console.error(e);
                setMsg("支払いは完了しましたが、注文反映に失敗しました。アプリに戻ってご確認ください。");
            }
        })();
    }, []);

    return (
        <main className="min-h-screen flex items-center justify-center p-6">
            <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-center space-y-4">
                <h1 className="text-lg font-semibold">決済成功</h1>
                <p className="text-sm text-zinc-600">{msg}</p>
                <a href="/" className="inline-block px-4 py-2 rounded-xl border bg-zinc-900 text-white">アプリに戻る</a>
            </div>
        </main>
    );
}
