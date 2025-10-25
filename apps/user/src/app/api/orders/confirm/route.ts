// apps/user/src/app/api/orders/confirm/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type ConfirmBody = {
  items: Array<{ sku: string; qty: number }>;
  total: number;
  pickupStart?: string | null;
  storeId?: string | null;
  customer?: string | null;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ConfirmBody;

    const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
    if (!secret) return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });
    const c = await cookies();
    const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
    if (!sess) return NextResponse.json({ ok: false, error: "no-line-session" }, { status: 401 });
    const lineUserId = sess.sub;

    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return NextResponse.json({ ok: false, error: "ITEMS_REQUIRED" }, { status: 400 });
    }
    if (typeof body?.total !== "number") {
      return NextResponse.json({ ok: false, error: "TOTAL_REQUIRED" }, { status: 400 });
    }

    const pickupStartIso =
      (body.pickupStart && new Date(body.pickupStart).toISOString()) || new Date().toISOString();

    const insertPayload: any = {
      status: "PENDING",
      total: body.total,
      items: body.items ?? null,
      customer: body.customer ?? null,
      store_id: body.storeId ?? null,
      pickup_start: pickupStartIso,
      reminded_at: null,
      line_user_id: lineUserId,
      placed_at: new Date().toISOString(),
    };

    const { data: order, error: insertErr } = await supabase
      .from("orders")
      .insert([insertPayload])
      .select("id, status, pickup_start, line_user_id")
      .single();

    if (insertErr) {
      console.error("[orders/confirm] insert error:", insertErr);
      return NextResponse.json(
        { ok: false, error: "ORDER_INSERT_FAILED", detail: insertErr.message },
        { status: 500 }
      );
    }

    if (!order.line_user_id) {
      const { error: fixErr } = await supabase
        .from("orders")
        .update({ line_user_id: lineUserId })
        .eq("id", order.id)
        .is("line_user_id", null);
      if (fixErr) console.error("[orders/confirm] fix line_user_id failed:", fixErr.message);
    }

    try {
      await linePush(lineUserId, [
        { type: "text", text: "ご注文ありがとうございます。受け取り時間までお待ちください。" },
      ]);
    } catch (pushErr: any) {
      console.error("[orders/confirm] push error:", pushErr?.message ?? pushErr);
    }

    const res = NextResponse.json({ ok: true, orderId: order.id });
    res.headers.set("x-orders-confirm", "user-app@v1");
    return res;
  } catch (e: any) {
    console.error("[orders/confirm] fatal:", e?.message ?? e);
    return NextResponse.json(
      { ok: false, error: "ORDER_CONFIRM_FATAL", detail: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

