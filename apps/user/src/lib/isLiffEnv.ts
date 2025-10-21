"use client";

// LIFF/LINE WebView 判定ユーティリティ
// - UA に Line を含む、または window.liff が存在する場合に true
// - NEXT_PUBLIC_FORCE_LIFF=1 で強制的に LIFF モードにできます（開発/検証用）
export function isLiffEnv(): boolean {
  try {
    if (process.env.NEXT_PUBLIC_FORCE_LIFF === "1") return true;
    if (typeof window === "undefined") return false;
    // window.liff があれば優先
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).liff) return true;
    const ua = navigator.userAgent || "";
    return /Line/i.test(ua);
  } catch {
    return false;
  }
}

