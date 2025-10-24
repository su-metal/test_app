export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ====== Supabase Server Client (service_role) ======
function getServiceClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ====== LIFF URL（https://liff.line.me/<LIFF_ID> 形式）======
const RAW_USER_LIFF_ID = process.env.USER_LIFF_ID ?? "YOUR_LIFF_ID"; // ← IDだけを入力
function makeLiffUrl(idOrUrl: string): string {
  let s = (idOrUrl || "").trim();
  s = s.replace(/^https?:\/\/[^/]+\/?/i, "");
  s = s.replace(/^liff\.line\.me\//i, "");
  s = s.replace(/^miniapp\.line\.me\//i, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return `https://liff.line.me/${s}`;
}
function isValidLiffUrl(u: string): boolean {
  return /^https:\/\/liff\.line\.me\/[A-Za-z0-9\-_]+$/.test(u);
}
const USER_LIFF_URL = makeLiffUrl(RAW_USER_LIFF_ID);

// ====== 署名検証 ======
function verifyLineSignature(rawBody: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return !!signature && hmac === signature;
}

// ====== LINE Messaging API 返信関数 ======
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

// ====== Webhook本体 ======
export async function POST(req: NextRequest) {
  // ※ セーフモード：絶対に throw しない。常に 200 で返す（LINEの再送ループ防止）
  let rawBody = "";
  let signature: string | null = null;

  try {
    rawBody = await req.text(); // ★ 1回しか読まない
    signature = req.headers.get("x-line-signature") || null;

    // 見えるログ（ここで落ちない）
    console.log("[LINE][SAFE] len=", rawBody.length, "sig=", !!signature);

    // ランタイムとenv確認ログ（500の定番チェック）
    if (process.env.LINE_CHANNEL_SECRET?.length) {
      // ok
    } else {
      console.warn("[LINE][SAFE] LINE_CHANNEL_SECRET is missing");
    }
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN?.length) {
      // ok
    } else {
      console.warn("[LINE][SAFE] LINE_CHANNEL_ACCESS_TOKEN is missing");
    }

    // 署名検証（NGでも 200 で返す—まずは落ちないことを最優先）
    let verified = false;
    try {
      verified = verifyLineSignature(rawBody, signature);
    } catch (e: any) {
      console.error("[LINE][SAFE] verify error", e?.message || e);
    }
    if (!verified) {
      console.warn(
        "[LINE][SAFE] invalid signature (but returning 200 for debug)"
      );
      return NextResponse.json(
        { ok: false, reason: "invalid-signature" },
        { status: 200 }
      );
    }

    // JSON 解析（失敗しても 200）
    let body: any = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : { events: [] };
    } catch (e: any) {
      console.error("[LINE][SAFE] json parse error", e?.message || e);
      return NextResponse.json(
        { ok: false, reason: "json-parse-failed" },
        { status: 200 }
      );
    }

    const events = body?.events ?? [];
    console.log(
      "[LINE][SAFE] events =",
      events.length,
      events.map((e: any) => e.type)
    );

    // 最小動作：message: "ping" → "pong"
    for (const event of events) {
      if (event?.type === "message" && event?.message?.type === "text") {
        const txt = String(event.message.text || "")
          .trim()
          .toLowerCase();
        if (txt === "ping") {
          const ok = await lineReply(event.replyToken, [
            { type: "text", text: "pong" },
          ]);
          console.log("[LINE][SAFE] reply pong =", ok);
        }
      }
      // follow 返信（URIはあなたの実装のままでもOK）
      if (event?.type === "follow") {
        const ok = await lineReply(event.replyToken, [
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
              actions: [{ type: "uri", label: "開く", uri: USER_LIFF_URL }],
            },
          },
        ]);
        console.log("[LINE][SAFE] follow reply =", ok);
      }
    }

    // ここまで来たら常に 200
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // どんな例外でも 200 を返す（ログだけ残す）
    console.error("[LINE][SAFE] fatal", e?.message || e);
    return NextResponse.json({ ok: false, reason: "fatal" }, { status: 200 });
  }
}

// ====== GETメソッド制限 ======
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
