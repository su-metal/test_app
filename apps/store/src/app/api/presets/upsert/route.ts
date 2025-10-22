import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { jwtVerify, createRemoteJWKSet } from 'jose';

// TODO(req v2): 本APIはLINEミニアプリ用のサインド検証を行います。
// 環境変数: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINE_CHANNEL_ID が必須です。

const LINE_JWKS = createRemoteJWKSet(new URL('https://api.line.me/oauth2/v2.1/certs'));

// 遅延取得（ビルド時に環境変数未設定でも落ちないようにする）
const supabaseAdmin = getSupabaseAdmin();

type BodyRow = {
  store_id: string;
  slot_no: number;
  name: string;
  start_time: string; // 'HH:mm:ss'
  end_time: string;   // 'HH:mm:ss'
  slot_minutes: number;
};

export async function POST(req: Request) {
  try {
    const headers = new Headers(req.headers);
    const idToken = headers.get('x-line-id-token');
    const devBypass = (process.env.NEXT_PUBLIC_DEV_SKIP_LIFF === '1') || (process.env.NODE_ENV !== 'production');

    const lineChannelId = process.env.LINE_CHANNEL_ID || process.env.LINE_LOGIN_CHANNEL_ID;
    let lineUserId = '';
    if (!idToken) {
      if (!devBypass) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      // dev: LIFF スキップ時はバイパス
      lineUserId = 'dev-bypass';
    } else {
      const { payload } = await jwtVerify(idToken, LINE_JWKS, {
        issuer: 'https://access.line.me',
        audience: lineChannelId,
      });
      lineUserId = String(payload.sub || '');
      if (!lineUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const rows: BodyRow[] = Array.isArray(body) ? body : [body];

    // メンバーシップ確認: store_members に (store_id, line_user_id) があるか
    // ない場合のフォールバックとして stores テーブルに line_user_id を直接持つ場合も許可
    const targetStoreIds = Array.from(new Set(rows.map(r => r.store_id)));
    if (targetStoreIds.length === 0) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    let allowedStoreIds: Set<string> = new Set();
    if (devBypass) {
      // 開発時はメンバー確認をバイパス（ローカル保存を容易にする）
      allowedStoreIds = new Set(targetStoreIds.map(String));
    } else {
      // store_members で確認
      const { data: members, error: memErr } = await supabaseAdmin
        .from('store_members')
        .select('store_id, line_user_id, role')
        .in('store_id', targetStoreIds)
        .eq('line_user_id', lineUserId);

      if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

      allowedStoreIds = new Set((members || []).map(m => String((m as any).store_id)));

      // フォールバック: stores.line_user_id = payload.sub
      const needFallbackIds = targetStoreIds.filter(id => !allowedStoreIds.has(id));
      if (needFallbackIds.length) {
        const { data: stores, error: storeErr } = await supabaseAdmin
          .from('stores')
          .select('id, line_user_id')
          .in('id', needFallbackIds)
          .eq('line_user_id', lineUserId);
        if (storeErr) return NextResponse.json({ error: storeErr.message }, { status: 500 });
        for (const s of stores || []) allowedStoreIds.add(String((s as any).id));
      }

      // 権限チェック
      if (!rows.every(r => allowedStoreIds.has(String(r.store_id)))) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
    }

    // upsert 実行（複数行対応）。onConflict: store_id,slot_no
    const { error } = await supabaseAdmin
      .from('store_pickup_presets')
      .upsert(rows, { onConflict: 'store_id,slot_no' });

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'error' }, { status: 500 });
  }
}
