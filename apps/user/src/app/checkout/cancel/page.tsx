"use client";

export default function CancelPage() {
  const backToHome = () => {
    try { sessionStorage.setItem("came_from_checkout", "1"); } catch { /* noop */ }
    // 履歴を残さずにホームへ戻る（戻るで決済系に戻れないようにする）
    if (typeof window !== "undefined") {
      window.location.replace("/?from=cancel");
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-center space-y-4">
        <h1 className="text-lg font-semibold">決済をキャンセルしました</h1>
        <button onClick={backToHome} className="inline-block px-4 py-2 rounded-xl border">アプリへ戻る</button>
      </div>
    </main>
  );
}

