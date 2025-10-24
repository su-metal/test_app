// apps/user/src/app/api/line/webhook/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

/* =========================
   0) 環境変数（Vercelに設定必須）
   - LINE_CHANNEL_SECRET
   - LINE_CHANNEL_ACCESS_TOKEN
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - USER_LIFF_ID  ← 例: 1651234567-abcd12（ID“だけ”）
   ========================= */

/* =========================
   1) Supabase（Server専用：service_role）
   ========================= */
function getServiceClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/* =========================
   2) LIFF URLの正規化（https://liff.line.me/<ID>）
   ========================= */
const RAW_USER_LIFF_ID = process.env.USER_LIFF_ID ?? "YOUR_LIFF_ID";
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

/* =========================
   3) 署名検証
   ========================= */
function verifyLineSignature(rawBody: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return !!signature && hmac === signature;
}

/* =========================
   4) Messaging API（reply）
   ========================= */
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

/* =========================
   5) Webhook 本体
   ========================= */
export async function POST(req: NextRequest) {
  try {
    // A) rawBody を1回だけ読む
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");

    // B) デバッグログ（見え方の確認用）
    console.log("[LINE] len=", rawBody.length, "sig=", !!signature);

    // C) 署名検証
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[LINE] invalid signature");
      return new NextResponse("invalid signature", { status: 401 });
    }

    // D) JSON 化
    const body = rawBody ? JSON.parse(rawBody) : { events: [] };

    // E) まずはイベントの要点を必ず出す（ここで userId を確認できます）
    console.log(
      "[LINE] events",
      (body.events ?? []).map((e: any) => ({
        type: e.type,
        source: e?.source?.type,
        userId: e?.source?.userId,
        msg: e?.message?.type,
      }))
    );

    // F) Supabase クライアント
    const supa = getServiceClient();

    // G) イベント処理
    for (const event of body.events ?? []) {
      /* --- ❶ follow: userId を DB に保存（= line_user_id） --- */
      if (event.type === "follow") {
        const lineUserId: string | undefined = event.source?.userId; // ← Uxxxxxxxx...
        if (lineUserId) {
          const { error } = await supa
            .from("user_profiles")
            .upsert(
              { line_user_id: lineUserId },
              { onConflict: "line_user_id" }
            );
          if (error) {
            console.error("Supabase upsert error", error);
          } else {
            console.log("[LINE] saved line_user_id:", lineUserId);
          }
        }

        // あいさつ＋ミニアプリ起動ボタン
        const uri = isValidLiffUrl(USER_LIFF_URL)
          ? USER_LIFF_URL
          : "https://liff.line.me/YOUR_LIFF_ID"; // フォールバック（必要なら置換）
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

      /* --- ❷ 動作テスト: 「ping」→「pong」 --- */
      if (event.type === "message" && event.message?.type === "text") {
        const txt = String(event.message.text || "")
          .trim()
          .toLowerCase();
        if (txt === "ping") {
          await lineReply(event.replyToken, [{ type: "text", text: "pong" }]);
        }
      }
    }

    // H) すぐに 200 を返す
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[LINE] fatal", e?.message || e);
    // ここで 500 を返すとLINEが再送してくるため、必要なら 200 にしてもOK
    return new NextResponse("internal error", { status: 500 });
  }
}

/* =========================
   6) GET は 405
   ========================= */
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
