// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cookies } from 'next/headers';
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from '@/lib/session';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * フロントからの想定ボディ
 * {
 *   storeId?: string,
 *   userEmail?: string,
 *   lines: { id?: string; name: string; price: number; qty: number }[],
 *   pickup?: string,
 *   returnUrl: string
 * }
 */
export async function POST(req: NextRequest) {  // LINE ユーザーID（存在時のみ）
  let lineUserId: string | undefined;
  try {
    const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
    if (secret) {
      const c = await cookies();
      const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
      const sub = sess?.sub && String(sess.sub).trim();
      if (sub) lineUserId = sub;
    }
  } catch { /* noop */ }
  try {
    const { storeId, userEmail, lines, pickup, returnUrl } = await req.json();

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json(
        { error: "line_items is empty" },
        { status: 400 }
      );
    }

    const currency = "jpy";
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = lines
      .map((l: any) => ({
        quantity: Number(l.qty) || 0,
        price_data: {
          currency,
          unit_amount: Math.max(0, Number(l.price) || 0),
          product_data: {
            name: l.name || "商品",
            metadata: { product_id: String(l.id ?? "") },
          },
        },
      }))
      .filter((li) => (li.quantity as number) > 0);

    // -------- 1) Customer をメールで取得 or 作成 --------
    let customerId: string | undefined;
    if (userEmail) {
      const existing = await stripe.customers.list({
        email: userEmail,
        limit: 1,
      });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const created = await stripe.customers.create({ email: userEmail });
        customerId = created.id;
      }
    }

    // -------- 2) セッション作成 --------
    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",

      // ★ カード選択を出すキー3点
      customer: customerId,
      payment_intent_data: {
        setup_future_usage: "off_session",
        ...(lineUserId ? { metadata: { line_user_id: lineUserId } } : {}),
      },

      // ★ 型にある指定だけを使う
      payment_method_types: ["card"],

      line_items,
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,

      // fulfill 側の要件: store_id, items_json, pickup_label, email
      metadata: {
        ...(lineUserId ? { line_user_id: lineUserId } : {}),
                store_id: String(storeId ?? ""),
        items_json: JSON.stringify(lines ?? []),
        pickup_label: String(pickup ?? ""),
        email: String(userEmail ?? ""),
        // 互換: 既存コードが参照する場合に備え保持
        pickup: String(pickup ?? ""),
      },
    };

    const session = await stripe.checkout.sessions.create(params);
    return NextResponse.json(
      { client_secret: session.client_secret },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[create-checkout-session] error:", err?.message || err);
    return NextResponse.json(
      { error: err?.message ?? "unknown" },
      { status: 400 }
    );
  }
}
