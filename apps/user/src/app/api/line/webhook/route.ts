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
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");

    // Debug Logs
    console.log("[LINE] headers", Object.fromEntries(req.headers));
    console.log("[LINE] raw length", rawBody.length);

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[LINE] invalid signature");
      return new NextResponse("invalid signature", { status: 401 });
    }

    const body = rawBody ? JSON.parse(rawBody) : { events: [] };
    console.log(
      "[LINE] events",
      (body.events ?? []).map((e: any) => ({
        type: e.type,
        ts: e.timestamp,
        userId: e?.source?.userId,
      }))
    );

    const supabase = getServiceClient();

    for (const event of body.events ?? []) {
      // ✅ 友だち追加：line_user_id を保存して挨拶返信
      if (event.type === "follow") {
        const lineUserId: string | undefined = event.source?.userId;

        if (lineUserId) {
          console.log("[LINE] follow from userId:", lineUserId);
          // Supabase に upsert
          const { error } = await supabase
            .from("user_profiles")
            .upsert(
              { line_user_id: lineUserId },
              { onConflict: "line_user_id" }
            );
          if (error) console.error("Supabase upsert error", error);
          else console.log("Supabase upsert success");
        }

        console.log("[LIFF URL check]", { RAW_USER_LIFF_ID, USER_LIFF_URL });
        const uri = isValidLiffUrl(USER_LIFF_URL)
          ? USER_LIFF_URL
          : "https://liff.line.me/YOUR_LIFF_ID"; // ← 念のためのフォールバック

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

      // ✅ テスト：トークで「ping」と送ると「pong」を返す
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

// ====== GETメソッド制限 ======
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
