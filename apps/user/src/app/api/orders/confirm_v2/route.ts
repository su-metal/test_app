// apps/user/src/app/api/orders/confirm_v2/route.ts
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

type Body = {
  items: Array<{ sku: string; qty: number }>;
  total: number;
  lineUserId?: string; // サーバセッションで確定
  pickupStart?: string | null; // 任意（ISO）。なければ now() 使用
  storeId?: string | null; // 任意テーブルなら任意
  customer?: string | null; // 任意テーブルなら任意
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

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
      items: body.items ?? null, // jsonb想定
      customer: body.customer ?? null, // text想定
      store_id: body.storeId ?? null, // NOT NULLなら必須で渡す
      pickup_start: pickupStartIso,
      reminded_at: null,
      line_user_id: lineUserId, // 必須
      placed_at: new Date().toISOString(),
    };

    const { data: order, error: insertErr } = await supabase
      .from("orders")
      .insert([insertPayload])
      .select("id, status, pickup_start, line_user_id")
      .single();

    if (insertErr) {
      console.error("[orders/confirm_v2] insert error:", insertErr);
      return NextResponse.json(
        { ok: false, error: "ORDER_INSERT_FAILED" },
        { status: 500 }
      );
    }

    if (!order.line_user_id) {
      const { error: fixErr } = await supabase
        .from("orders")
        .update({ line_user_id: lineUserId })
        .eq("id", order.id)
        .is("line_user_id", null); // 冪等
      if (fixErr)
        console.error(
          "[orders/confirm_v2] fix line_user_id failed:",
          fixErr.message
        );
    }

    // 簡易Push
    try {
      await linePush(lineUserId, [
        { type: "text", text: "✅ ご注文ありがとうございます。受け取り10分前にリマインドします。" },
      ]);
    } catch (e) {
      console.error("[orders/confirm_v2] push warn:", (e as any)?.message ?? e);
    }

    const res = NextResponse.json({ ok: true, orderId: order.id });
    res.headers.set("x-orders-confirm", "user-app@v2");
    return res;
  } catch (e) {
    console.error("[orders/confirm_v2] fatal:", (e as any)?.message ?? e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

