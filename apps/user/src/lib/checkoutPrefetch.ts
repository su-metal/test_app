"use client";

import { getLiffIdTokenCached } from "./liffTokenCache";

export type CheckoutPayload = {
  storeId: string;
  userEmail: string;
  lines: { id: string; name: string; price: number; qty: number }[];
  pickup: string;
  devSkipLiff: boolean;
  returnUrl: string;
};

type CacheEntry = {
  clientSecret: string;
  signature: string;
  ts: number;
};

let cache: CacheEntry | null = null;
let inflight: { signature: string; promise: Promise<string> } | null = null;

export function signatureOf(p: CheckoutPayload): string {
  // 安定化した署名: 値のみを抽出して並び順固定
  const base = {
    s: p.storeId,
    e: p.userEmail || "",
    l: p.lines.map((x) => ({ i: x.id, p: Number(x.price) || 0, q: Number(x.qty) || 0 })),
    k: p.pickup || "",
  };
  return JSON.stringify(base);
}

export function invalidateCacheIfMismatch(sig: string) {
  if (cache && cache.signature !== sig) cache = null;
}

export function clearCache() { cache = null; }

export function getCached(sig: string): string | null {
  if (cache && cache.signature === sig) return cache.clientSecret;
  return null;
}

export async function prefetchCheckout(p: CheckoutPayload, opts?: { timeoutMs?: number }): Promise<string> {
  const sig = signatureOf(p);
  // 既存キャッシュ
  if (cache && cache.signature === sig) return cache.clientSecret;
  if (inflight && inflight.signature === sig) return inflight.promise;

  const timeout = Math.max(3000, Math.min(opts?.timeoutMs ?? 7000, 15000));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeout);

  inflight = {
    signature: sig,
    promise: (async () => {
      try {
        const isLocal = typeof window !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "[::1]");
        const idToken = isLocal || p.devSkipLiff ? null : (await getLiffIdTokenCached());

        const res = await fetch("/api/stripe/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            storeId: p.storeId,
            userEmail: p.userEmail,
            lines: p.lines,
            pickup: p.pickup,
            ...(idToken ? { id_token: idToken } : { dev_skip_liff: true }),
            returnUrl: p.returnUrl,
          }),
          credentials: "include",
          signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || "create-checkout-session error");
        const json = JSON.parse(text);
        const cs: string | undefined = json?.client_secret;
        if (!cs) throw new Error("client_secret missing");
        cache = { clientSecret: cs, signature: sig, ts: Date.now() };
        return cs;
      } finally {
        clearTimeout(t);
        inflight = null;
      }
    })(),
  };

  return inflight.promise;
}

