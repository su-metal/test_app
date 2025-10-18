// apps/user/src/app/api/stripe/create-intent/route.ts
import Stripe from "stripe";
import { NextRequest } from "next/server";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY! /* ここでは apiVersion を指定しない */
);

export async function POST(req: NextRequest) {
  try {
    const { storeId, userEmail, lines, pickup } = await req.json();

    // 合計金額（税・送料なしの単純合計）
    const amount = Number(
      (Array.isArray(lines) ? lines : []).reduce(
        (a: number, l: any) =>
          a + (Number(l.price) || 0) * (Number(l.qty) || 0),
        0
      )
    );

    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: "invalid amount" }), {
        status: 400,
      });
    }

    // PaymentIntent を作成（Payment Element 用）
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount), // JPY は整数
      currency: "jpy",
      receipt_email: userEmail || undefined,
      metadata: {
        storeId: String(storeId ?? ""),
        pickup: String(pickup ?? ""),
        lines: JSON.stringify(lines ?? []),
      },
      automatic_payment_methods: { enabled: true },
    });

    return new Response(JSON.stringify({ client_secret: pi.client_secret }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[create-intent] error", e);
    return new Response(
      JSON.stringify({ error: e?.message ?? "server error" }),
      { status: 500 }
    );
  }
}
