"use client";
export default function CancelPage() {
    return (
        <main className="min-h-screen flex items-center justify-center p-6">
            <div className="max-w-[480px] w-full rounded-2xl border bg-white p-5 text-center space-y-4">
                <h1 className="text-lg font-semibold">決済をキャンセルしました</h1>
                <a href="/" className="inline-block px-4 py-2 rounded-xl border">戻る</a>
            </div>
        </main>
    );
}
