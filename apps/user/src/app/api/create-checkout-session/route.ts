import Stripe from "stripe";
import { NextResponse } from "next/server";

export const runtime = "nodejs"; // Edge禁止（stripeはNodeランタイムが楽）

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin") ?? "http://localhost:3000";
    // デモ用：その場で価格を埋め込む（JPY/税込みの金額を最小単位=円で指定）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "jpy",
            unit_amount: 1200, // ¥1,200
            product_data: { name: "デモ商品（お試し）" },
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel`,
    });

    // どちらでもOK：①URLを返してwindow.locationで遷移、②sessionIdでredirectToCheckout
    return NextResponse.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "failed_to_create_session" },
      { status: 500 }
    );
  }
}
