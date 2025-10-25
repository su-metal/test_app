import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// 一括パスワードリセット/リカバリメール送信
// 環境変数:
// - ADMIN_DASHBOARD_SECRET: 管理用シークレット（存在する場合は必須）
// - NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: supabase 管理権限

export const runtime = "nodejs";

export async function POST(req: Request) {
  const adminSecret = process.env.ADMIN_DASHBOARD_SECRET;
  if (adminSecret) {
    const header = new Headers(req.headers).get("x-admin-secret");
    if (header !== adminSecret) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const supa = getSupabaseAdmin();

  // mode: 'recovery' | 'temporary'
  // recovery: 再設定メール送信（推奨）
  // temporary: 暫定PW再設定（運用時は requires_pw_update フラグ併用を推奨）
  let body: { mode?: string; temporary_password?: string } = {};
  try { body = (await req.json()) as any; } catch {}
  const mode = (body.mode || 'recovery').toLowerCase();
  const temporaryPassword = String(body.temporary_password || '').trim() || null;

  try {
    // stores から auth_user_id と email を収集（owner）
    const { data: stores, error: qerr } = await supa
      .from('stores')
      .select('id, email, auth_user_id')
      .not('auth_user_id', 'is', null);
    if (qerr) return NextResponse.json({ error: qerr.message }, { status: 500 });

    let processed = 0;
    let errors: Array<{ id: string; error: string }> = [];

    for (const s of stores || []) {
      const storeId = String((s as any).id);
      const email = String((s as any).email || '').trim();
      if (!email) { errors.push({ id: storeId, error: 'no-email' }); continue; }

      if (mode === 'temporary') {
        if (!temporaryPassword) return NextResponse.json({ error: 'temporary_password required' }, { status: 400 });
        const list = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 } as any);
        if (list.error) { errors.push({ id: storeId, error: list.error.message }); continue; }
        const user = list.data.users.find(u => String(u.email || '').toLowerCase() === email.toLowerCase());
        if (!user) { errors.push({ id: storeId, error: 'user-not-found' }); continue; }
        const upd = await supa.auth.admin.updateUserById(user.id, { password: temporaryPassword });
        if (upd.error) { errors.push({ id: storeId, error: upd.error.message }); continue; }
        processed++;
        // TODO(req v2): store_members.requires_pw_update = true をセット
      } else {
        // recovery: Supabase から再設定メールを送信
        const link = await supa.auth.admin.generateLink({ type: 'recovery', email });
        if (link.error) { errors.push({ id: storeId, error: link.error.message }); continue; }
        processed++;
      }
    }

    return NextResponse.json({ ok: true, mode, processed, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}

export function GET() { return new NextResponse('Method Not Allowed', { status: 405 }); }

