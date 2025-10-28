"use client";

// LIFF の ID トークンをメモリにキャッシュして即参照できるようにする
// TODO(req v2): 有効期限(exp)の厳密判定と更新タイミングの調整

let cachedToken: string | null = null;
let lastFetchAt = 0; // ms
let inflight: Promise<string | null> | null = null;

function isLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

export function setCachedLiffIdToken(token: string | null) {
  cachedToken = token || null;
  lastFetchAt = Date.now();
}

export async function getLiffIdTokenCached(): Promise<string | null> {
  // ローカル開発では不要
  if (isLocalhost()) return null;
  // キャッシュが最近なら返す（30秒の緩いしきい値）
  if (cachedToken && Date.now() - lastFetchAt < 30_000) return cachedToken;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const mod = await import("@line/liff");
      const t = mod.default.getIDToken?.() ?? null;
      cachedToken = t || null;
      lastFetchAt = Date.now();
      return cachedToken;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

