import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

function verifyLineSignature(body: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET!;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  return signature && hmac === signature;
}

// --- 追加: 返信関数（Messaging API reply endpoint） ---
async function lineReply(replyToken: string, messages: any[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
  return res.ok;
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");

    if (!verifyLineSignature(rawBody, signature)) {
      return new NextResponse("invalid signature", { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const events = body.events ?? [];

    for (const event of events) {
      // 友だち追加イベントの時
      if (event.type === "follow") {
        await lineReply(event.replyToken, [
          {
            type: "text",
            text: "ご登録ありがとうございます！下のボタンからミニアプリを開けます👇",
          },
          {
            type: "template",
            altText: "ミニアプリを開く",
            template: {
              type: "buttons",
              text: "ミニアプリを開く",
              actions: [
                {
                  type: "uri",
                  label: "ミニアプリを開く",
                  uri: "https://liff.line.me/<USER_LIFF_ID>", // あなたのLIFF IDを入れる
                },
              ],
            },
          },
        ]);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[LINE Webhook] error", e);
    return new NextResponse("internal error", { status: 500 });
  }
}
