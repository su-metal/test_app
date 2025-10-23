import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs"; // 重要：Edgeだとcryptoの動作が不安定

function verifyLineSignature(body: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET!;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  return signature && hmac === signature;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text(); // 署名検証は「生のテキスト」で
  const signature = req.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  // いったんログだけ（後で処理を足す）
  console.log("[LINE Webhook] raw:", rawBody);

  // LINEは200を早く返すことを推奨
  return NextResponse.json({ ok: true });
}
