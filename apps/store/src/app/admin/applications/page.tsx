// apps/store/src/app/admin/applications/page.tsx
'use client';

import { useEffect, useState } from 'react';

const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_DASHBOARD_SECRET; // フロント用（値は別名で公開してOK）

type Application = {
    id: string;
    store_name: string;
    owner_name: string;
    email: string;
    phone: string | null;
    status: string;
    created_at: string;
};

export default function ApplicationsAdminPage() {
    const [items, setItems] = useState<Application[]>([]);
    const [loading, setLoading] = useState(false);
    const [pw, setPw] = useState('InitPass123!'); // その場で編集可能

    async function load() {
        setLoading(true);
        const res = await fetch('/api/admin/store-applications/list', {
            headers: ADMIN_SECRET ? { 'x-admin-secret': ADMIN_SECRET } : undefined,
            cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        setLoading(false);
        if (!res.ok) {
            alert(data?.error ?? '読み込みに失敗しました');
            return;
        }
        setItems(data.applications ?? []);
    }

    async function approve(id: string) {
        const temp = prompt('初期パスワードを入力してください（後で変更できます）', pw) || pw;
        const res = await fetch('/api/admin/approve-store', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(ADMIN_SECRET ? { 'x-admin-secret': ADMIN_SECRET } : {}),
            },
            body: JSON.stringify({ application_id: id, temp_password: temp }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data?.error ?? '承認に失敗しました');
            return;
        }
        alert('承認しました');
        load();
    }

    useEffect(() => {
        load();
    }, []);

    return (
        <div className="p-6">
            <h1 className="text-xl font-semibold mb-4">店舗参加申請（pending）</h1>
            <div className="mb-3">
                <label className="text-sm mr-2">承認時の初期パスワード:</label>
                <input
                    className="rounded border px-2 py-1"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="InitPass123!"
                />
            </div>
            <button
                className="rounded bg-black text-white px-3 py-2 mb-4"
                onClick={load}
                disabled={loading}
            >
                {loading ? '読込中…' : '再読み込み'}
            </button>
            <div className="space-y-3">
                {items.length === 0 && <p>pending はありません。</p>}
                {items.map((a) => (
                    <div key={a.id} className="border rounded p-3 flex items-center justify-between">
                        <div className="text-sm">
                            <div className="font-medium">{a.store_name}</div>
                            <div>代表者: {a.owner_name}</div>
                            <div>メール: {a.email}</div>
                            {a.phone && <div>電話: {a.phone}</div>}
                            <div className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString()}</div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                className="rounded bg-green-600 text-white px-3 py-2"
                                onClick={() => approve(a.id)}
                            >
                                承認
                            </button>
                            {/* 却下を入れるならここに追加（status='rejected' 更新APIを用意） */}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
