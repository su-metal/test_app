// apps/user/src/app/api/line/webhook/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// --- LIFF URL（必ず https://liff.line.me/<LIFF_ID> 形式）---
const USER_LIFF_ID = process.env.USER_LIFF_ID ?? "2008314807-lxkoyj4r"; // ← 環境変数にあるならそれを使用
const USER_LIFF_URL = `https://liff.line.me/${USER_LIFF_ID}`;

function verifyLineSignature(rawBody: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return !!signature && hmac === signature;
}

// Messaging API: reply
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

    // デバッグログ
    console.log("[LINE] headers", Object.fromEntries(req.headers));
    console.log("[LINE] raw length", rawBody.length);

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[LINE] invalid signature");
      return new NextResponse("invalid signature", { status: 401 });
    }

    const body = rawBody ? JSON.parse(rawBody) : { events: [] };
    console.log(
      "[LINE] events",
      (body.events ?? []).map((e: any) => ({ type: e.type, ts: e.timestamp }))
    );

    for (const event of body.events ?? []) {
      // 友だち追加→ あいさつ＋ミニアプリ起動ボタン
      if (event.type === "follow") {
        const uri = USER_LIFF_URL.startsWith("https://liff.line.me/")
          ? USER_LIFF_URL
          : "https://liff.line.me/2008314807-lxkoyj4r";
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
              actions: [{ type: "uri", label: "開く", uri }],
            },
          },
        ]);
      }

      // テスト：トークで「ping」と送ると「pong」を返す
      if (event.type === "message" && event.message?.type === "text") {
        const txt = (event.message.text || "").trim().toLowerCase();
        if (txt === "ping") {
          await lineReply(event.replyToken, [{ type: "text", text: "pong" }]);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[LINE Webhook] fatal", e?.message || e);
    return new NextResponse("internal error", { status: 500 });
  }
}

// 他メソッドは 405
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
