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
          pickup: "—",
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
