import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  try {
    const { client_secret, payment_method } = (await req.json()) as {
      client_secret: string;
      payment_method: string;
    };

    const piId = client_secret.split("_secret_")[0];
    const confirmed = await stripe.paymentIntents.confirm(piId, {
      payment_method,
      return_url: "https://example.com/return", // 使わないなら省略可
    });

    return NextResponse.json({ status: confirmed.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "server error" },
      { status: 500 }
    );
  }
}
