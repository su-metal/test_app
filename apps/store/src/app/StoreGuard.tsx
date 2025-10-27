// apps/store/src/app/StoreGuard.tsx
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
    let cancelled = false;

    (async () => {
      try {
        // 店舗選択不要なパスは素通り（現行ロジック維持）
        const allow = ["/select-store", "/login", "/api", "/admin"].some((p) =>
          pathname?.startsWith(p)
        );
        if (allow) return;

        // 1) まずはメモリ/環境変数/localStorage から即時判定（現行ロジック維持）
        let sid =
          (typeof window !== "undefined" && (window as any).__STORE_ID__) ||
          (process.env.NEXT_PUBLIC_STORE_ID as string | undefined) ||
          "";
        if (!isValidUuid(sid)) {
          try {
            const v = localStorage.getItem("store:selected");
            if (typeof v === "string" && v.trim()) {
              sid = v.trim();
              (window as any).__STORE_ID__ = sid;
            }
          } catch {
            /* noop */
          }
        }
        if (isValidUuid(sid)) return;

        // 2) サーバーセッション確認（すでに選択済みならそれを採用）
        const insp = await fetch("/api/auth/session/inspect", {
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);

        const inspectedId: string | null =
          insp?.store_id && isValidUuid(insp.store_id) ? insp.store_id : null;

        if (inspectedId) {
          (window as any).__STORE_ID__ = inspectedId;
          try {
            localStorage.setItem("store:selected", inspectedId);
            localStorage.setItem("store:last_store_id", inspectedId);
          } catch { }
          return;
        }

        // 3) 未選択の場合、自動候補を決めてサーバーに選択をPOST
        const ls = await fetch("/api/auth/session/list-stores", {
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);

        const stores: { id: string; name?: string }[] = Array.isArray(ls?.stores)
          ? ls.stores
          : [];

        if (stores.length === 0) {
          // 所属店舗なし → 既存どおり選択画面へ
          router.replace("/select-store");
          return;
        }

        // 直近選択の復元（存在しなければ先頭）
        let targetId = stores[0].id;
        try {
          const last = localStorage.getItem("store:last_store_id");
          const found = stores.find((s) => last && s.id === last);
          if (found) targetId = found.id;
        } catch {
          /* noop */
        }

        const ok = await fetch("/api/auth/session/select-store", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storeId: targetId }),
        })
          .then((r) => r.ok)
          .catch(() => false);

        if (ok) {
          try {
            localStorage.setItem("store:selected", targetId);
            localStorage.setItem("store:last_store_id", targetId);
          } catch { }
          // 画面を選択済み状態に確実に更新
          location.reload();
          return;
        }

        // 自動選択に失敗した場合は従来どおり手動選択へ
        router.replace("/select-store");
      } catch {
        // エラー時も安全側に倒す
        router.replace("/select-store");
      }

      return () => {
        cancelled = true;
      };
    })();
  }, [pathname, router]);

  // レイアウト用：UIはここでは描画しない（現行と同じ挙動）
  return null;
}
