// apps/user/src/app/api/checkout/embedded/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    // フロントから来る想定ボディ
    // { amount: number, currency?: 'jpy', email?: string, metadata?: any, returnUrl: string }
    const {
      amount,
      currency = "jpy",
      email,
      metadata,
      returnUrl,
    } = await req.json();

    // -------- 1) Customer をメールで取得 or 作成 --------
    let customerId: string | undefined;
    if (email) {
      const existing = await stripe.customers.list({ email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const created = await stripe.customers.create({ email });
        customerId = created.id;
      }
    }

    // -------- 2) セッション作成（型に合う最小構成） --------
    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",

      // ★ カード選択を出すキー3点
      customer: customerId,
      payment_intent_data: { setup_future_usage: "off_session" },

      // ★ 型に確実にある指定に寄せる（automatic_payment_methodsは使わない）
      payment_method_types: ["card"],

      // 単一アイテムで合計金額を請求（必要に応じて調整）
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: Number(amount) || 0,
            product_data: { name: "注文" },
          },
        },
      ],

      // Embedded は return_url が必須
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,

      // 任意のメタ
      metadata: metadata || undefined,
    };

    const session = await stripe.checkout.sessions.create(params);
    return NextResponse.json(
      { client_secret: session.client_secret },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[embedded] error:", e?.message || e);
    return NextResponse.json(
      { error: e?.message ?? "unknown" },
      { status: 400 }
    );
  }
}
