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
  const secret = process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  let expectedStoreId: string | null = null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: "server misconfig: supabase" }), { status: 500 });
  }
  if (!secret) {
    return new Response(JSON.stringify({ error: "server misconfig: secret" }), { status: 500 });
  }

  try {
    const cookieStore = await cookies();
    const sess = verifySessionCookie(cookieStore.get(COOKIE_NAME)?.value, secret);
    if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    expectedStoreId = String(sess.store_id || "").trim() || null;
    if (!expectedStoreId) return new Response(JSON.stringify({ error: "store_not_selected" }), { status: 400 });

    const body = (await req.json().catch(() => ({}))) as { rows?: PresetRow[]; current_slot_no?: 1 | 2 | 3 };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) {
      return new Response(JSON.stringify({ error: "rows required" }), { status: 400 });
    }

    // Strict validation: every row must target this store only
    // TODO(req v2): 所属店舗の厳密な検証（store_members 等）に置換。
    for (const r of rows) {
      if (r.store_id !== expectedStoreId) {
        return new Response(JSON.stringify({ error: "forbidden: store mismatch" }), { status: 403 });
      }
    }

    const supabase = createClient(url, serviceKey);

    const { error: upErr } = await supabase
      .from("store_pickup_presets")
      .upsert(rows as any, { onConflict: "store_id,slot_no" });
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
    const status = /unauthorized|forbidden/i.test(msg) ? 401 : 500;
    return new Response(JSON.stringify({ error: msg }), { status });
  }
}
