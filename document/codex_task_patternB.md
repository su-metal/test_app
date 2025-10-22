# Codex タスク指示書：LINEミニアプリ用サイレント認証（パターンB）実装

## 🎯 目的
LINEミニアプリ上で「受取時間プリセット（store_pickup_presets）」を変更できるようにする。  
ログイン画面を表示せず、LIFFのIDトークンによるサイレント認証で本人確認・権限チェックを行い、  
サーバー経由（service_role使用）で Supabase に upsert する。

---

## 🧱 依存関係
以下のライブラリを追加する。

```bash
pnpm add jose @line/liff
```

---

## 🔐 環境変数 (.env.local など)
```
NEXT_PUBLIC_LIFF_ID=<LIFF ID>
LINE_CHANNEL_ID=<LINEチャネルID>
SUPABASE_SERVICE_ROLE_KEY=<Supabase Service Role Key>
```

必要に応じて（開発時のみ）：
```
ADMIN_DASHBOARD_SECRET=<任意の管理用キー>
```

---

## 🗂 サーバーAPI新規作成
### ファイルパス
`apps/store/src/app/api/presets/upsert/route.ts`

### 実装要件
- HTTPメソッド: `POST`
- 受信Body:  
  `{ store_id, slot_no, name, start_time, end_time, slot_minutes }`
- 受信ヘッダ:  
  `x-line-id-token` — LIFFから取得したIDトークン
- 処理内容:
  1. `x-line-id-token` を取得
  2. `jose` を使用して署名とクレームを検証  
     - iss: `https://access.line.me`  
     - aud: `process.env.LINE_CHANNEL_ID`
  3. 検証OKなら `payload.sub`（LINEユーザーID）を取得
  4. 権限チェック  
     - 優先: `store_members(store_id, line_user_id, role)` に一致行がある  
     - 代替: `stores.id = store_id AND stores.line_user_id = payload.sub`
  5. 権限OKなら **service_role** クライアントで upsert  
     ```ts
     upsert(
       { store_id, slot_no, name, start_time, end_time, slot_minutes },
       { onConflict: 'store_id,slot_no' }
     );
     ```
  6. 成功時: `200 { ok: true }`  
     権限なし: `403 { error: 'forbidden' }`  
     トークン検証失敗: `401 { error: 'unauthorized' }`  
     その他エラー: `500 { error: string }`

### 実装条件サンプル
```ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const LINE_JWKS = createRemoteJWKSet(new URL('https://api.line.me/oauth2/v2.1/certs'));

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export async function POST(req: Request) {
  try {
    const idToken = new Headers(req.headers).get('x-line-id-token');
    if (!idToken) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const { payload } = await jwtVerify(idToken, LINE_JWKS, {
      issuer: 'https://access.line.me',
      audience: process.env.LINE_CHANNEL_ID,
    });

    const lineUserId = String(payload.sub);
    const body = await req.json();

    // 権限チェック（store_members or stores）
    const { data: member } = await admin
      .from('store_members')
      .select('store_id, role')
      .eq('store_id', body.store_id)
      .eq('line_user_id', lineUserId)
      .maybeSingle();

    if (!member) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const { error } = await admin
      .from('store_pickup_presets')
      .upsert(body, { onConflict: 'store_id,slot_no' });

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'error' }, { status: 500 });
  }
}
```

---

## 🧩 クライアント側の修正
対象: 受取時間プリセットの保存処理があるページまたはコンポーネント  
（例）  
- `apps/store/src/app/admin/pickup-presets/page.tsx`  
- `apps/store/src/components/StorePickupPresetsForm.tsx`

### 保存処理置き換え例
```ts
import liff from '@line/liff';

async function onSavePreset(payload: {
  store_id: string;
  slot_no: number;
  name: string;
  start_time: string;
  end_time: string;
  slot_minutes: number;
}) {
  await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID! });
  if (!liff.isLoggedIn()) liff.login();

  const idToken = liff.getIDToken();
  const res = await fetch('/api/presets/upsert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-line-id-token': idToken!,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? '保存に失敗しました');
}
```

---

## 🧾 DB 権限テーブル（任意）
もしまだ存在しない場合は、以下を作成。

```sql
create table if not exists public.store_members (
  store_id uuid not null references public.stores(id) on delete cascade,
  line_user_id text not null,
  role text not null default 'admin',
  primary key (store_id, line_user_id)
);
create index if not exists store_members_user_idx on public.store_members(line_user_id);
```

---

## ✅ 受け入れ基準（AC）
1. LIFF 起動時に `liff.getIDToken()` が取得できる  
2. 正規メンバーが保存操作 → `200 { ok: true }` + DB 反映  
3. 非メンバーが保存操作 → `403 { error: 'forbidden' }`  
4. 無効トークン → `401 { error: 'unauthorized' }`  
5. ミニアプリ上でログイン画面を出さずに保存完了

---

## 🧪 動作確認手順
1. LINEミニアプリから対象ページを開く  
2. コンソールで `liff.getIDToken()` の値を確認  
3. 保存ボタンを押す  
   - 正常：DBの `store_pickup_presets` に反映  
   - 権限なし：403  
4. Supabaseダッシュボードで `service_role` 経由の更新を確認
