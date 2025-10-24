// app/api/stripe/fulfill/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// 6桁コード（サーバ側で生成）
function code6() {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("session_id");
    if (!sessionId)
      return NextResponse.json({ error: "MISSING_SESSION" }, { status: 400 });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    if (session.payment_status !== "paid") {
      return NextResponse.json({ error: "NOT_PAID" }, { status: 400 });
    }

    const store_id = session.metadata?.store_id as string | undefined;
    const items_json = session.metadata?.items_json;
    const pickup_label = (session.metadata?.pickup_label as string | undefined) || "";
    const email =
      (session.metadata?.email as string | undefined) ||
      session.customer_email ||
      "guest@example.com";

    if (!store_id || !items_json) {
      return NextResponse.json({ error: "MISSING_METADATA" }, { status: 400 });
    }

    const items = JSON.parse(items_json) as Array<{
      id: string;
      name: string;
      qty: number;
      price: number;
    }>;
    const total = items.reduce(
      (a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    // Supabase REST へ INSERT（RLSが許可されている前提）
    const payload = {
      store_id,
      code: code6(),
      customer: email,
      items, // JSONB
      total, // 数値
      status: "PENDING", // 店側で引換完了に更新する前の状態
    };

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
    const row = Array.isArray(rows) ? rows[0] : rows;

    // TODO(req v2): move stock decrement into a DB transaction (RPC) for atomicity
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
              const u = await fetch(`${API_URL}/rest/v1/products?id=eq.${encodeURIComponent(pid)}&store_id=eq.${encodeURIComponent(store_id)}`, {
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

    // フロントのローカル履歴へ反映しやすい形で返す
    const orderForClient = {
      id: String(row?.id ?? ""),
      userEmail: email,
      shopId: store_id,
      amount: total,
      status: "paid" as const, // ユーザー側表示は「未引換」
      code6: String(payload.code),
      createdAt: Date.now(),
      lines: items.map((it) => ({
        shopId: store_id,
        item: {
          id: it.id,
          name: it.name,
          price: it.price,
          stock: 0,
          pickup: pickup_label || "—",
          note: "",
          photo: "🛍️",
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
