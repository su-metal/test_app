# タスク: 受取時間プリセット保存の不具合を解消して“必ず保存できる”状態にする

## 対象リポジトリ前提
- Next.js App Router（apps/store）
- 既に以下が存在すると仮定：  
  - `apps/store/src/app/api/presets/upsert/route.ts`（LIFFのIDトークン検証＋service_roleでupsert）  
  - `apps/store/src/lib/pickupPresets.ts` に `upsertPickupPresetsViaApi(presets)` が実装済み  
- Supabase DB：`public.store_pickup_presets (store_id uuid, slot_no int, name text, start_time time, end_time time, slot_minutes int, ...)

---

## ゴール（Acceptance Criteria）
1. 画面の保存操作時、**/api/presets/upsert** が呼ばれ、200 `{ ok: true }` を返す  
2. `public.store_pickup_presets` に **`(store_id, slot_no)` で upsert** が反映される（新規作成・更新ともに成功）  
3. LIFF 実行時は **ログイン画面なし**（サイレント認証）で保存完了  
4. 非メンバーは 403、無効トークンは 401 を返す  
5. 開発時に `NEXT_PUBLIC_DEV_SKIP_LIFF=1` を設定すると、SDK直upsertで保存可能（RLSが通る場合）

---

## 作業指示（順番厳守）

### 1) UIが新APIを呼ぶように置換（最重要）
- 「受取時間プリセット」を保存している**実コンポーネント/ページ**を特定し、  
  既存の `supabase.from('store_pickup_presets').upsert(...)` や独自 fetch を **下記に置換**する。

**置換後の呼び出し（配列推奨）**
```ts
import { upsertPickupPresetsViaApi } from '@/lib/pickupPresets';

await upsertPickupPresetsViaApi([
  { slot_no: 1, name: '昼', start_time: '10:00:00', end_time: '14:00:00', slot_minutes: 10 },
  // 必要に応じて複数
]);
```

> `store_id` はヘルパー内の `getMyStoreId()`（実装済み前提）で付与される設計。  
> もしUI側で `store_id` を強制指定している箇所があれば削除するか、API側で無視する。

**検索パターン（いずれかにヒットするファイルを置換）**
- `rest/v1/store_pickup_presets`
- `from('store_pickup_presets').upsert(`
- `fetch(`/api/presets/upsert``
- `pickup` / `preset` / `slot_minutes` / `start_time` / `end_time`

出力：置換対象ファイルの **Before/After差分** を提示。

---

### 2) API ルートの健全性チェック
ファイル：`apps/store/src/app/api/presets/upsert/route.ts`

- 署名検証：`jose` の `jwtVerify` + JWKS `https://api.line.me/oauth2/v2.1/certs`  
  - `issuer: 'https://access.line.me'`  
  - `audience: process.env.LINE_CHANNEL_ID || process.env.LINE_LOGIN_CHANNEL_ID`
- 権限チェック：次のいずれかで OK を要求  
  - `store_members (store_id, line_user_id, role)` に該当行  
  - `stores.line_user_id = payload.sub` で該当行  
- upsert：`supabaseAdmin.from('store_pickup_presets').upsert(rows, { onConflict: 'store_id,slot_no' })`  
  - 引数は **単体/配列** 両対応  
- エラーハンドリング：401/403/500 の JSON 形（`{ error: string }`）

出力：差分（必要があれば完全ファイル）。

---

### 3) 環境変数／再起動
`.env.local`（または相当）に次を確認・不足時は追加し dev 再起動：
```
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_LIFF_ID=...
LINE_CHANNEL_ID=...   # または LINE_LOGIN_CHANNEL_ID=...
```
開発簡略化（任意）：
```
NEXT_PUBLIC_DEV_SKIP_LIFF=1
```
出力：検出結果（存在有無）と不足分の追加提案。

---

### 4) DB制約/型の整備
- upsert の安定動作のため、複合ユニーク制約を **存在すれば維持、無ければ作成**：
```sql
alter table public.store_pickup_presets
  add constraint if not exists store_pickup_presets_uq unique (store_id, slot_no);
```
- `start_time` / `end_time` が `time` 型の場合、**`HH:mm:ss`** で送るよう UI 側フォーマットを確認。  
  必要なら `pickupPresets.ts` 内で補正（`HH:mm` → `HH:mm:00`）。

出力：DDL と UI 側の必要差分。

---

### 5) 権限データの投入
**どちらか**を満たす SQL を提示（実行例を出力）：
- store_members：
```sql
insert into public.store_members (store_id, line_user_id, role)
values ('<STORE_ID>', '<LINE_SUB>', 'admin')
on conflict (store_id, line_user_id) do nothing;
```
- stores：
```sql
update public.stores
   set line_user_id = '<LINE_SUB>'
 where id = '<STORE_ID>';
```

---

### 6) 検証観点（自動チェック用ログの追加可）
- UI：保存クリック → Network に **`/api/presets/upsert`** が出現  
- ステータスが以下のいずれか  
  - 200 `{ ok: true }` → OK  
  - 401 → `x-line-id-token` 未付与 or aud/iss不一致（ログに詳細）  
  - 403 → メンバー紐付け無し（どのチェックで落ちたかログ）  
  - 500 → env不足/型ミス（エラーログ出力）  
- DB：`store_pickup_presets` に該当レコードが upsert されている

出力：手元でテスト可能な **簡易テスト手順** と、期待レスポンス例。

---

## 最終出力フォーマット
1. **発見一覧**（置換対象ファイルのパスと該当行抜粋）  
2. **変更差分**（Before/After、または完全ファイル）  
3. **追加/修正した環境変数一覧**  
4. **実行すべきSQL（権限紐付け・制約作成）**  
5. **動作確認手順**（NetworkとDBでの確認ポイント）  

> 目的は「保存ボタンを押すと、/api/presets/upsert が呼ばれ、DBに upsert が反映される」状態を**確実に再現**すること。UIの呼び替えが未実施でも**必ず実施**できるよう、ファイル単位の最小差分を提示してください。
