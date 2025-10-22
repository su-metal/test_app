// apps/user/src/app/liff/apply/page.tsx
'use client';

import { useState } from 'react';

export default function StoreApplyPage() {
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setLoading(true);

        const fd = new FormData(e.currentTarget);
        const payload = {
            store_name: fd.get('store_name'),
            owner_name: fd.get('owner_name'),
            email: fd.get('email'),
            phone: fd.get('phone'),
        };

        const res = await fetch('/api/store-applications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        setLoading(false);
        if (res.ok) {
            setDone(true);
        } else {
            const data = await res.json().catch(() => ({}));
            setError(data?.error ?? '送信に失敗しました。しばらくしてから再度お試しください。');
        }
    }

    if (done) {
        return (
            <div className="p-6 space-y-3">
                <h1 className="text-xl font-semibold">申請を受け付けました</h1>
                <p>審査が完了次第、ご登録のメール（またはLINE）にご連絡します。</p>
            </div>
        );
    }

    return (
        <div className="p-6 mx-auto max-w-md">
            <h1 className="text-xl font-semibold mb-4">店舗参加申請</h1>
            <form className="space-y-3" onSubmit={onSubmit}>
                <label className="block">
                    <span className="text-sm">店舗名（必須）</span>
                    <input
                        name="store_name"
                        required
                        className="mt-1 w-full rounded border px-3 py-2"
                        placeholder="（例）すーちゃんラーメン 東銀座店"
                    />
                </label>

                <label className="block">
                    <span className="text-sm">代表者名（必須）</span>
                    <input
                        name="owner_name"
                        required
                        className="mt-1 w-full rounded border px-3 py-2"
                        placeholder="山田 太郎"
                    />
                </label>

                <label className="block">
                    <span className="text-sm">メールアドレス（必須）</span>
                    <input
                        type="email"
                        name="email"
                        required
                        className="mt-1 w-full rounded border px-3 py-2"
                        placeholder="owner@example.com"
                        inputMode="email"
                    />
                </label>

                <label className="block">
                    <span className="text-sm">電話番号（任意）</span>
                    <input
                        name="phone"
                        className="mt-1 w-full rounded border px-3 py-2"
                        placeholder="090-0000-0000"
                        inputMode="tel"
                    />
                </label>

                {error && (
                    <p className="text-sm text-red-600">{error}</p>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded bg-black text-white py-2 disabled:opacity-50"
                >
                    {loading ? '送信中…' : '申請する'}
                </button>
            </form>
        </div>
    );
}
