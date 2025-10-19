// LIFF クライアント初期化（ユーザーアプリ用最小ユーティリティ）
// TODO(req v2): 認証連携（IDトークン → サーバー検証）を追加

import type { Liff } from '@line/liff';

let liffInstance: Liff | null = null;
let initPromise: Promise<Liff> | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function normalizeLiffId(raw?: string | null): string {
  if (!raw) return '';
  const v = String(raw).trim();
  // miniapp URL が入ってきた場合に LIFF ID を抽出（許容運用）
  // 例: https://miniapp.line.me/2008314807-xxxxxx → 2008314807-xxxxxx
  try {
    if (v.startsWith('http')) {
      const u = new URL(v);
      if (u.hostname.endsWith('line.me')) {
        const seg = u.pathname.replace(/^\/+/, '');
        if (seg) return seg;
      }
    }
  } catch {
    // noop
  }
  return v;
}

export async function ensureLiffInitialized(opts?: { liffId?: string; debug?: boolean }): Promise<Liff> {
  if (!isBrowser()) {
    throw new Error('LIFF はブラウザ環境でのみ初期化できます');
  }
  if (liffInstance) return liffInstance;
  if (initPromise) return initPromise;

  const debug = !!opts?.debug || process.env.NEXT_PUBLIC_DEBUG === '1';
  const rawId = opts?.liffId ?? process.env.NEXT_PUBLIC_LIFF_ID ?? '';
  const liffId = normalizeLiffId(rawId);
  if (!liffId) throw new Error('NEXT_PUBLIC_LIFF_ID が未設定です');

  initPromise = (async () => {
    const mod = await import('@line/liff');
    const liff = mod.default as Liff;
    if (debug) console.info('[LIFF] init start (id=%s)', liffId);
    await liff.init({ liffId });
    if (debug) console.info('[LIFF] init done. inClient=%s loggedIn=%s', liff.isInClient(), liff.isLoggedIn());
    // デバッグ用に window へ露出
    (window as any).__LIFF__ = liff;
    liffInstance = liff;
    return liff;
  })();

  return initPromise;
}

export async function loginIfNeeded(redirectUri?: string): Promise<void> {
  if (!isBrowser()) return;
  const liff = await ensureLiffInitialized();
  if (liff.isInClient()) return; // LINE アプリ内はログイン不要
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: redirectUri || window.location.href });
  }
}

export async function getIdToken(): Promise<string | null> {
  const liff = await ensureLiffInitialized();
  try {
    return liff.getIDToken() ?? null;
  } catch {
    return null;
  }
}

export async function getBasicProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string } | null> {
  const liff = await ensureLiffInitialized();
  try {
    const p = await liff.getProfile();
    return { userId: p.userId, displayName: p.displayName, pictureUrl: (p as any).pictureUrl };
  } catch {
    return null;
  }
}

export function resetLiffForTests() {
  // テスト用（未使用）。必要に応じて初期化状態をリセット
  liffInstance = null;
  initPromise = null;
}

