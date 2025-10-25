import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { COOKIE_NAME, verifySessionCookie } from "@/lib/session";

type PresetRow = {
  store_id: string;
  slot_no: 1 | 2 | 3;
  name: string;
  start_time: string; // HH:MM:SS
  end_time: string;   // HH:MM:SS
  slot_minutes: number;
};

export async function POST(req: NextRequest) {
  const secret = process.env.STORE_SESSION_SECRET || process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  let expectedStoreId: string | null = null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return new Response(JSON.stringify({ error: "server misconfig: supabase" }), { status: 500 });
  if (!secret) return new Response(JSON.stringify({ error: "server misconfig: secret" }), { status: 500 });

  try {
    const cookieStore = await cookies();
    const sess = verifySessionCookie(cookieStore.get(COOKIE_NAME)?.value, secret);
    if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    expectedStoreId = String(sess.store_id || "").trim() || null;
    if (!expectedStoreId) return new Response(JSON.stringify({ error: "store_not_selected" }), { status: 400 });

    const body = (await req.json().catch(() => ({}))) as { rows?: Partial<PresetRow>[]; current_slot_no?: 1 | 2 | 3 };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return new Response(JSON.stringify({ error: "rows required" }), { status: 400 });

    // サーバー側で store_id を強制付与（クライアント値は無視）
    const normalized = rows.map((r) => ({
      store_id: expectedStoreId!,
      slot_no: r.slot_no as 1 | 2 | 3,
      name: String(r.name || "").trim(),
      start_time: String((r as any).start_time || "00:00:00"),
      end_time: String((r as any).end_time || "00:00:00"),
      slot_minutes: Number((r as any).slot_minutes || 10),
    }));

    const supabase = createClient(url, serviceKey);
    const { error: upErr } = await supabase
      .from("store_pickup_presets")
      .upsert(normalized as any, { onConflict: "store_id,slot_no" });
    if (upErr) throw upErr;

    if (body.current_slot_no) {
      const { error: stErr } = await supabase
        .from("stores")
        .update({ current_pickup_slot_no: body.current_slot_no })
        .eq("id", expectedStoreId);
      if (stErr) throw stErr;
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const status = /unauthorized/i.test(msg) ? 401 : /forbidden/i.test(msg) ? 403 : 500;
    return new Response(JSON.stringify({ error: msg }), { status });
  }
}

