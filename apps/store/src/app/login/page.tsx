"use client";
import { useState } from 'react';
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
    try {
      const r = await fetch('/api/auth/login/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      setLoading(false);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErrorMsg(j?.error || 'ログインに失敗しました'); return; }
      if (j?.need_store_select) {
        location.replace('/select-store');
        return;
      }
      const next = new URLSearchParams(location.search).get('next') || '/';
      location.replace(next);
    } catch (err) {
      setLoading(false);
      setErrorMsg((err as any)?.message || 'ログインに失敗しました');
      return;
    }
  }

  async function onResetPassword() { alert('パスワードリセットは未設定です'); }
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


