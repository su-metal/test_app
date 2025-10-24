// apps/user/src/app/api/orders/confirm/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

// パスエイリアス(@/*)が未設定なら相対パスに変えてください：
// import { linePush } from '../../../../lib/line';
import { linePush } from "@/lib/line";

import { createClient } from "@supabase/supabase-js";

function getServiceClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function makeLiffTicketsUrl(orderId: string) {
  const liffId = process.env.USER_LIFF_ID!;
  const qs = new URLSearchParams({ redirect: "/tickets", orderId }).toString();
  return `https://liff.line.me/${liffId}?${qs}`;
}

export async function POST(req: NextRequest) {
  try {
    const supa = getServiceClient();
    const {
      items,
      amount,
      authUserId,
      lineUserId: rawLineUserId,
    } = await req.json();

    // 1) まずは注文を保存（あなたの実装に合わせてカラム名は調整）
    const { data: order, error: orderErr } = await supa
      .from("orders")
      .insert({
        auth_user_id: authUserId ?? null,
        items,
        amount,
        status: "confirmed",
      })
      .select("id")
      .single();

    if (orderErr || !order) {
      console.error("order insert error", orderErr);
      return NextResponse.json(
        { ok: false, error: "ORDER_SAVE_FAILED" },
        { status: 500 }
      );
    }

    const orderId: string = order.id;

    // 2) 宛先の line_user_id を決定（優先度：bodyのlineUserId → DB）
    let to = rawLineUserId || null;

    if (!to && authUserId) {
      const { data, error } = await supa
        .from("line_users") // 先に作ったLINE専用テーブル
        .select("line_user_id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error) console.error("lookup line_user_id error", error);
      to = data?.line_user_id ?? null;
    }

    // 3) 送信
    if (to) {
      const url = makeLiffTicketsUrl(orderId);
      await linePush(to, [
        {
          type: "text",
          text: "ご注文を受け付けました。ありがとうございます！",
        },
        {
          type: "template",
          altText: "チケットを見る",
          template: {
            type: "buttons",
            text: "チケットを見る",
            actions: [{ type: "uri", label: "開く", uri: url }],
          },
        },
      ]);
    } else {
      console.warn("push skipped: no line_user_id", { authUserId });
    }

    return NextResponse.json({ ok: true, orderId });
  } catch (e: any) {
    console.error("[orders/confirm] fatal", e?.message || e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
