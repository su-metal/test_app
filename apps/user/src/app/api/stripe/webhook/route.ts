// apps/user/src/app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 署名検証に raw body が必要

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// E-3: 冪等テーブルに記録する（なければ作成しておくこと）
async function recordProcessed(
  eventId: string,
  type: string,
  orderId?: string
) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const res = await fetch(`${API_URL}/rest/v1/processed_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates", // 既存なら無視
    },
    body: JSON.stringify({
      event_id: eventId,
      type,
      order_id: orderId ?? null,
    }),
    cache: "no-store",
  });
  return res.ok;
}

async function isProcessed(eventId: string) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const r = await fetch(
    `${API_URL}/rest/v1/processed_events?event_id=eq.${encodeURIComponent(
      eventId
    )}&select=event_id`,
    {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      cache: "no-store",
    }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("stripe-signature");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !whsec)
      return new NextResponse("missing signature", { status: 400 });

    const raw = await req.text();
    const event = stripe.webhooks.constructEvent(raw, sig, whsec);

    // 冪等：二重は即スキップ
    if (await isProcessed(event.id))
      return new NextResponse("ok", { status: 200 });

    // HH:MM(〜|?|-)HH:MM を当日JSTのISOへ変換
    function parsePickupLabelToJstIsoRange(label?: string): { start?: string; end?: string } {
      // どんな区切り(〜,～,-,–,—, to, 空白など)でも「時刻2つ」を検出して当日JSTのISOへ
      const text = String(label || "").trim();
      if (!text) return {};
      const m = text.match(/\b(\d{1,2}:\d{2})\b.*?\b(\d{1,2}:\d{2})\b/);
      if (!m) return {};
      const a = m[1];
      const b = m[2];
      const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
      const toIso = (hhmm: string) => {
        const [hh, mm] = hhmm.split(":");
        const parts = new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date());
        const y = parts.find((p) => p.type === "year")?.value ?? "1970";
        const mo = parts.find((p) => p.type === "month")?.value ?? "01";
        const d = parts.find((p) => p.type === "day")?.value ?? "01";
        return `${y}-${mo}-${d}T${pad(hh)}:${pad(mm)}:00+09:00`;
      };
      return { start: toIso(a), end: toIso(b) };
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = String((session.metadata as any)?.order_id || "");
      // Stripe 側メタデータ（Session / PI）を統合
      const md: Record<string, any> = (session.metadata || {}) as any;
      let piMeta: Record<string, any> = {};
      try { piMeta = ((session.payment_intent as any)?.metadata || {}) as any; } catch {}
      const meta = { ...piMeta, ...md } as Record<string, any>;
      const totalYenStr: string | undefined = meta.total_yen;
      const itemsJson: string | undefined = meta.items_json;
      const pickupLabel: string | undefined = meta.pickup_label;
      const presetJson: string | undefined = meta.pickup_presets_json;

      // C-2: Stripe側の支払成功を二重確認（任意拡張）
      // TODO(req v2): 金額/通貨/支払い状態の再検証と保存（専用カラム追加）

      if (orderId) {
        // C-3: 注文確定（DBの状態は PENDING のまま。placed_at を刻む）
        try {
          const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const SERVICE =
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
          if (API_URL && SERVICE) {
            const patch: Record<string, any> = { placed_at: new Date().toISOString() };
            if (typeof totalYenStr === 'string' && /^\d+$/.test(totalYenStr)) {
              const n = Math.max(0, Number(totalYenStr) || 0);
              patch.total = n;
              // TODO(req v2): ここでは小計=合計（送料・手数料なし）
              patch.subtotal = n;
            }
            if (typeof itemsJson === 'string' && itemsJson.trim()) {
              try { patch.items = JSON.parse(itemsJson); } catch {}
            }
            if (typeof pickupLabel === 'string' && pickupLabel.trim()) {
              patch.pickup_label = pickupLabel;
              const r = parsePickupLabelToJstIsoRange(pickupLabel);
              if (r.start) patch.pickup_start = r.start;
              if (r.end) patch.pickup_end = r.end;
            }
            if (typeof presetJson === 'string' && presetJson.trim()) {
              try { patch.pickup_presets_snapshot = JSON.parse(presetJson); } catch {}
            }
            console.info("[stripe/webhook] checkout.session.completed", {
              orderId,
              hasItems: !!patch.items,
              itemsCount: Array.isArray(patch.items) ? patch.items.length : undefined,
              total: patch.total,
              pickup_label: patch.pickup_label,
            });
            await fetch(`${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`,
              {
                method: "PATCH",
                headers: {
                  apikey: SERVICE,
                  Authorization: `Bearer ${SERVICE}`,
                  "Content-Type": "application/json",
                  Prefer: "return=minimal",
                },
                body: JSON.stringify(patch),
              }
            );

            // 注文確定の簡易通知（必要に応じて）
            try {
              const to = String(meta.line_user_id || "").trim();
              const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
              if (to && token) {
                // 店舗名の取得（表示用）
                let storeName: string | undefined;
                try {
                  const storeId = String(meta.store_id || '').trim();
                  if (storeId && API_URL) {
                    const sRes = await fetch(`${API_URL}/rest/v1/stores?id=eq.${encodeURIComponent(storeId)}&select=name&limit=1`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }, cache: 'no-store' });
                    if (sRes.ok) { const arr = await sRes.json(); storeName = arr?.[0]?.name || undefined; }
                  }
                } catch {}
                const totalText = typeof patch.total === 'number' ? `合計: ￥${patch.total.toLocaleString('ja-JP')}` : '';
                const pickupText = patch.pickup_label ? `受取時間: ${patch.pickup_label}` : '';
                const body = {
                  to,
                  messages: [
                    { type: 'text', text: [storeName ? `【${storeName}】` : '', 'ご注文ありがとうございました。', totalText, pickupText].filter(Boolean).join('\n') || 'ご注文ありがとうございました。' },
                  ],
                };
                await fetch('https://api.line.me/v2/bot/message/push', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(body),
                });
              }
            } catch (e) {
              console.warn('[stripe/webhook] line push warn:', (e as any)?.message || e);
            }
          }
        } catch {}
      }

      await recordProcessed(event.id, event.type, orderId || undefined);
      return new NextResponse("ok", { status: 200 });
    }

    // その他は記録のみ
    await recordProcessed(event.id, event.type);
    return new NextResponse("ok", { status: 200 });
  } catch (e: any) {
    console.error("[stripe/webhook] error:", e?.message || e);
    return new NextResponse("bad request", { status: 400 });
  }
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
