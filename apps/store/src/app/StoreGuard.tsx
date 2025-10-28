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
    (async () => {
      try {
        const allow = ["/select-store", "/login", "/api", "/admin"].some((p) => pathname?.startsWith(p));
        if (allow) return;

        // 1) 既に window/env に有効な値があれば許可
        let sid = (typeof window !== "undefined" && (window as any).__STORE_ID__) || (process.env.NEXT_PUBLIC_STORE_ID as string | undefined) || "";
        if (isValidUuid(sid)) return;

        // 2) localStorage フォールバック
        try {
          const v = localStorage.getItem("store:selected");
          if (typeof v === "string" && v.trim()) {
            sid = v.trim();
            if (isValidUuid(sid)) {
              (window as any).__STORE_ID__ = sid;
              return;
            }
          }
        } catch {
          /* noop */
        }

        // 3) サーバセッション照会（Cookie ベース）
        try {
          const r = await fetch("/api/auth/session/inspect", { credentials: "include", cache: "no-store" });
          const j = (await r.json().catch(() => ({}))) as any;
          const srv = r.ok && typeof j?.store_id === "string" ? String(j.store_id).trim() : "";
          if (isValidUuid(srv)) {
            (window as any).__STORE_ID__ = srv;
            try {
              localStorage.setItem("store:selected", srv);
            } catch {
              /* noop */
            }
            return;
          }
        } catch {
          /* noop */
        }

        // 4) 確定できない場合のみ店舗選択へ
        router.replace("/select-store");
      } catch {
        // noop
      }
    })();
  }, [pathname, router]);

  return null;
}

