// apps/user/src/app/api/orders/confirm_v2/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Body = {
  items: Array<{ sku: string; qty: number }>;
  total: number;
  lineUserId: string; // 必須（LIFFの sub, "U..."）
  pickupStart?: string | null; // 任意（ISO）。なければ now() を入れる
  storeId?: string | null; // あるテーブルなら渡す
  customer?: string | null; // あるテーブルなら渡す
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    if (!body?.lineUserId) {
      return NextResponse.json(
        { ok: false, error: "LINE_USER_ID_REQUIRED" },
        { status: 400 }
      );
    }
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return NextResponse.json(
        { ok: false, error: "ITEMS_REQUIRED" },
        { status: 400 }
      );
    }
    if (typeof body?.total !== "number") {
      return NextResponse.json(
        { ok: false, error: "TOTAL_REQUIRED" },
        { status: 400 }
      );
    }

    const pickupStartIso =
      (body.pickupStart && new Date(body.pickupStart).toISOString()) ||
      new Date().toISOString();

    const insertPayload: any = {
      status: "PENDING",
      total: body.total,
      items: body.items ?? null, // jsonbがあれば
      customer: body.customer ?? null, // textがあれば
      store_id: body.storeId ?? null, // NOT NULLなら必須で渡す
      pickup_start: pickupStartIso,
      reminded_at: null,
      line_user_id: body.lineUserId, // ★ここだけ必須
      placed_at: new Date().toISOString(), // 列があれば
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
        .update({ line_user_id: body.lineUserId })
        .eq("id", order.id)
        .is("line_user_id", null); // 冪等
      if (fixErr)
        console.error(
          "[orders/confirm_v2] fix line_user_id failed:",
          fixErr.message
        );
    }

    // 任意：到達確認の軽いPush（失敗は致命にしない）
    try {
      await linePush(body.lineUserId, [
        {
          type: "text",
          text: "🍜 ご注文を受け付けました。受け取り10分前にリマインドします。",
        },
      ]);
    } catch (e) {
      console.error("[orders/confirm_v2] push warn:", (e as any)?.message ?? e);
    }

    const res = NextResponse.json({ ok: true, orderId: order.id });
    res.headers.set("x-orders-confirm", "user-app@v2"); // 識別ヘッダ
    return res;
  } catch (e) {
    console.error("[orders/confirm_v2] fatal:", (e as any)?.message ?? e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
