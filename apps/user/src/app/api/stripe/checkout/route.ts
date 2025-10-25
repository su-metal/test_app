// app/api/stripe/checkout/route.ts
import Stripe from "stripe";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // あなたの payload に合わせてプロパティ名を調整
    const userEmail: string | undefined = body.userEmail;
    const storeId: string | undefined = body.storeId;
    const pickupLabel: string | undefined = body.pickupLabel; // 例: "18:00〜19:00"
    const lines: Array<{
      id: string;
      name: string;
      price: number;
      qty: number;
    }> = body.lines;

    // 簡易バリデーション（必要に応じて強化）
    if (!Array.isArray(lines) || lines.length === 0) {
      return new Response(JSON.stringify({ error: "line_items is empty" }), {
        status: 400,
      });
    }

    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] =
      lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: "jpy",
          unit_amount: Math.round(l.price),
          product_data: {
            name: l.name,
            description: pickupLabel
              ? `受取予定時間: ${pickupLabel}`
              : undefined,
          },
        },
      }));

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL!;
    if (!baseUrl) {
      throw new Error("NEXT_PUBLIC_BASE_URL is not set");
    }

    // LINE ユーザーID（存在時のみ）
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded",
      return_url: `${baseUrl}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
      customer_email: userEmail || undefined,
      line_items,
      ...(pickupLabel
        ? {
            custom_text: {
              submit: { message: `受取予定時間: ${pickupLabel}` },
            },
          }
        : {}),
      metadata: {
        store_id: storeId ?? "",
        ...(pickupLabel ? { pickup_label: pickupLabel } : {}),
        ...(lineUserId ? { line_user_id: lineUserId } : {}),
      },
      payment_intent_data: {
        metadata: {
          store_id: storeId ?? "",
          ...(pickupLabel ? { pickup_label: pickupLabel } : {}),
          ...(lineUserId ? { line_user_id: lineUserId } : {}),
        },
      },
    });

    return new Response(
      JSON.stringify({
        id: session.id,
        client_secret: session.client_secret,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[/api/stripe/checkout] error:", e);
    return new Response(
      JSON.stringify({ error: e?.message || "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
