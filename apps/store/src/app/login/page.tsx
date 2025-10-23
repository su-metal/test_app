"use client";
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    const form = e.currentTarget as any;
    const email = form.email.value as string;
    const password = form.password.value as string;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) { setErrorMsg(error.message); return; }
    const next = new URLSearchParams(location.search).get('next') || '/';
    location.replace(next);
  }

  async function onResetPassword() {
    const email = (document.querySelector('input[name="email"]') as HTMLInputElement | null)?.value || '';
    const input = window.prompt('パスワード再設定用のメールアドレスを入力してください', email);
    if (!input) return;
    const { error } = await supabase.auth.resetPasswordForEmail(input, { redirectTo: window.location.origin + '/login' });
    if (error) alert(error.message); else alert('再設定用のメールを送信しました');
  }

  return (
    <form onSubmit={onSubmit} className="p-6 space-y-4 max-w-sm mx-auto">
      <h1 className="text-xl font-semibold">店舗ログイン</h1>
      {errorMsg && (
        <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">{errorMsg}</div>
      )}
      <input name="email" type="email" className="w-full border rounded px-3 py-2" placeholder="メールアドレス" required />
      <input name="password" type="password" className="w-full border rounded px-3 py-2" placeholder="パスワード" required />
      <button className="w-full rounded bg-black text-white py-2" disabled={loading}>
        {loading ? 'ログイン中…' : 'ログイン'}
      </button>
      <div className="text-center">
        <button type="button" onClick={onResetPassword} className="text-sm text-blue-700 hover:underline">
          パスワードをお忘れの方（再設定）
        </button>
      </div>
    </form>
  );
}

