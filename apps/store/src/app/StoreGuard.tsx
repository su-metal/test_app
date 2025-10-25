"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

function isValidUuid(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(s);
}

export default function StoreGuard() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    try {
      const allow = ["/select-store", "/login", "/api", "/admin"].some((p) => pathname?.startsWith(p));
      if (allow) return;
      let sid = (typeof window !== "undefined" && (window as any).__STORE_ID__) || (process.env.NEXT_PUBLIC_STORE_ID as string | undefined) || "";
      if (!isValidUuid(sid)) {
        // localStorage フォールバック
        try {
          const v = localStorage.getItem('store:selected');
          if (typeof v === 'string' && v.trim()) {
            sid = v.trim();
            (window as any).__STORE_ID__ = sid;
          }
        } catch { /* noop */ }
      }
      if (!isValidUuid(sid)) {
        router.replace("/select-store");
      }
    } catch {
      // noop
    }
  }, [pathname, router]);

  return null;
}
