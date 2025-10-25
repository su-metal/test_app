// app/api/stripe/fulfill/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function code6() {
  return Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("session_id");
    if (!sessionId) return NextResponse.json({ error: "MISSING_SESSION" }, { status: 400 });

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
    if (session.payment_status !== "paid") {
      return NextResponse.json({ error: "NOT_PAID" }, { status: 400 });
    }

    const store_id = session.metadata?.store_id as string | undefined;
    const order_id = session.metadata?.order_id as string | undefined;
    const pickup_label = (session.metadata?.pickup_label as string | undefined) || "";
    const email = (session.metadata?.email as string | undefined) || session.customer_email || "guest@example.com";

    // 決済品目（新方式: 注文取得 / 旧方式: metadata.items_json）
    let items: Array<{ id: string; name: string; qty: number; price: number }> = [];
    if (order_id) {
      const r = await fetch(`${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order_id)}&select=items,store_id,code`, {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, cache: 'no-store'
      });
      if (!r.ok) return NextResponse.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
      const rows = await r.json();
      const row0 = Array.isArray(rows) ? rows[0] : rows;
      items = Array.isArray(row0?.items) ? (row0.items as any) : [];
    } else {
      const items_json = session.metadata?.items_json;
      if (!store_id || !items_json) return NextResponse.json({ error: "MISSING_METADATA" }, { status: 400 });
      items = JSON.parse(items_json) as any;
    }
    const total = items.reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);

    function parsePickupLabelToJstIsoRange(label: string | undefined): { start?: string; end?: string } {
      // ラベルの区切り文字に依存せず、最初の2つの HH:MM を抽出
      // TODO(req v2): メタデータに構造化した開始/終了を持たせる
      const text = String(label || "").trim();
      if (!text) return {};
      const times = text.match(/\b(\d{1,2}:\d{2})\b/g);
      if (!times || times.length < 2) return {};
      const [a, b] = times;
      const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
      const toIso = (hhmm: string) => {
        const [hh, mm] = hhmm.split(":");
        const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
        const y = parts.find((p) => p.type === "year")?.value ?? "1970";
        const mo = parts.find((p) => p.type === "month")?.value ?? "01";
        const d = parts.find((p) => p.type === "day")?.value ?? "01";
        return `${y}-${mo}-${d}T${pad(hh)}:${pad(mm)}:00+09:00`;
      };
      return { start: toIso(a), end: toIso(b) };
    }
    const pick = parsePickupLabelToJstIsoRange(pickup_label);

    let row: any;
    if (order_id) {
      // 既存注文（PENDING）を確定扱い（placed_at を付与）。冪等: 複数回でも問題なし
      await fetch(`${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order_id)}`, {
        method: 'PATCH',
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${ANON}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ placed_at: new Date().toISOString(), ...(pick.start ? { pickup_start: pick.start } : {}), ...(pick.end ? { pickup_end: pick.end } : {}) }),
      });
      const r = await fetch(`${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order_id)}&select=*`, {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, cache: 'no-store'
      });
      const arr = await r.json();
      row = Array.isArray(arr) ? arr[0] : arr;
    } else {
      // 後方互換: ここで注文を作成（TODO(req v2): 段階的廃止）
      let lineUserId: string | undefined = (session.metadata?.line_user_id as string | undefined);
      try {
        if (!lineUserId) {
          const pi: any = session.payment_intent;
          const metaVal = pi?.metadata?.line_user_id;
          if (typeof metaVal === 'string' && metaVal.trim()) lineUserId = metaVal.trim();
        }
      } catch { /* noop */ }
      if (!lineUserId) {
        try {
          const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
          if (secret) {
            const c = await cookies();
            const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
            const sub = sess?.sub && String(sess.sub).trim();
            if (sub) lineUserId = sub;
          }
        } catch { /* noop */ }
      }

      const payload: any = {
        store_id,
        code: code6(),
        customer: email,
        items,
        total,
        status: "PENDING",
      };
      if (lineUserId) (payload as any).line_user_id = lineUserId;
      if (pick?.start) payload.pickup_start = pick.start;
      if (pick?.end) payload.pickup_end = pick.end;

      const res = await fetch(`${API_URL}/rest/v1/orders?select=*`, {
        method: "POST",
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${ANON}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Supabase insert failed: ${res.status} ${t}`);
      }
      const rows = await res.json();
      row = Array.isArray(rows) ? rows[0] : rows;
    }

    // TODO(req v2): 在庫減算はトランザクション/RPCで原子的に行う
    try {
      const qtyById = new Map<string, number>();
      for (const it of items) {
        const id = String(it.id);
        const q = Math.max(0, Number(it.qty) || 0);
        qtyById.set(id, (qtyById.get(id) || 0) + q);
      }

      if (qtyById.size > 0) {
        const idsIn = Array.from(qtyById.keys()).map(encodeURIComponent).join(',');
        const qRes = await fetch(`${API_URL}/rest/v1/products?id=in.(${idsIn})&select=id,stock,store_id`, {
          method: 'GET',
          headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
          cache: 'no-store',
        });
        if (qRes.ok) {
          const curRows = (await qRes.json()) as Array<{ id: string; stock?: number; store_id?: string }>;
          for (const r of curRows) {
            const pid = String(r.id);
            const dec = qtyById.get(pid) || 0;
            if (!dec) continue;
            const current = Math.max(0, Number(r.stock || 0) || 0);
            const next = Math.max(0, current - dec);
            try {
              const u = await fetch(`${API_URL}/rest/v1/products?id=eq.${encodeURIComponent(pid)}&store_id=eq.${encodeURIComponent(store_id || String(row?.store_id || ""))}`, {
                method: 'PATCH',
                headers: {
                  apikey: ANON,
                  Authorization: `Bearer ${ANON}`,
                  'Content-Type': 'application/json',
                  Prefer: 'return=minimal',
                },
                body: JSON.stringify({ stock: next }),
              });
              if (!u.ok) {
                const t = await u.text().catch(() => '');
                console.error('[stripe/fulfill] stock update failed', pid, u.status, t);
              }
            } catch (e) {
              console.error('[stripe/fulfill] stock update error', pid, e);
            }
          }
        }
      }
    } catch (e) {
      console.error('[stripe/fulfill] stock decrement block error', e);
    }

    // クライアントのローカル保存用に簡易構造で返す
    const orderForClient = {
      id: String(row?.id ?? ""),
      userEmail: email,
      shopId: (store_id || String(row?.store_id || "")),
      amount: total,
      status: "paid" as const,
      code6: String((row?.code) ?? ""),
      createdAt: Date.now(),
      lines: items.map((it) => ({
        shopId: (store_id || String(row?.store_id || "")),
        item: {
          id: it.id,
          name: it.name,
          price: it.price,
          stock: 0,
          pickup: pickup_label || "?",
          note: "",
          photo: "???",
        },
        qty: it.qty,
      })),
    };

    return NextResponse.json({ ok: true, order: orderForClient });
  } catch (e: any) {
    console.error("[stripe/fulfill] error:", e?.message || e);
    return NextResponse.json({ error: "FULFILL_FAILED" }, { status: 500 });
  }
}

