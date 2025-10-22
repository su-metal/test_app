'use client';
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Login() {
    const [loading, setLoading] = useState(false);
    async function onSubmit(e: any) {
        e.preventDefault();
        setLoading(true);
        const email = e.target.email.value;
        const password = e.target.password.value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        setLoading(false);
        if (error) return alert(error.message);
        const next = new URLSearchParams(location.search).get('next') || '/';
        location.href = next;
    }
    return (
        <form onSubmit={onSubmit} className="p-6 space-y-3 max-w-sm mx-auto">
            <h1 className="text-xl font-semibold">店舗ログイン</h1>
            <input name="email" type="email" className="w-full border rounded px-3 py-2" placeholder="email" required />
            <input name="password" type="password" className="w-full border rounded px-3 py-2" placeholder="password" required />
            <button className="w-full rounded bg-black text-white py-2" disabled={loading}>
                {loading ? 'ログイン中…' : 'ログイン'}
            </button>
        </form>
    );
}
