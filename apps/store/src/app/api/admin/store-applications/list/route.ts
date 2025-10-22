import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const ADMIN_SECRET = process.env.ADMIN_DASHBOARD_SECRET;

export async function GET(req: Request) {
  if (ADMIN_SECRET) {
    const header = new Headers(req.headers).get("x-admin-secret");
    if (header !== ADMIN_SECRET) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const { data, error } = await supabaseAdmin
    .from("store_applications")
    .select("id, store_name, owner_name, email, phone, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ applications: data ?? [] });
}
