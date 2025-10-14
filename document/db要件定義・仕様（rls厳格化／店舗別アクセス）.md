# フードロス削減アプリ（LINEミニアプリ）

# DB要件定義・仕様（RLS厳格化／店舗別アクセス）

最終更新: 2025-10-13 / 対象プロジェクト: `dsrueuqshqdtkrprcjmc` / DB: `postgres`

---

## 1. 目的・スコープ

- **目的**: 各参加店舗が自店舗データのみを安全にREAD/WRITEできるよう、**マルチテナント境界**をPostgreSQL RLSで厳格化する。
- **到達状態**:
  - 未ログイン(`anon`)からの書込みは不可。
  - ログイン済(`authenticated`)は**自店舗(**``**)一致行のみ**読み書き可能。
  - 決済Webhook/バッチ等は `service_role` として**限定的に**権限付与。
  - クリティカル列は**列権限**と**トリガー**の二重ガード。
  - ステータスは**PENDING → PAID → FULFILLED**の正規遷移以外不可。
  - いつでも\*\*止めずに戻せる（ロールバック容易）\*\*運用設計。

---

## 2. ロール & JWT 要件

- **クライアント（LINEミニアプリ）**: `role=authenticated` のJWTでアクセス。
  - JWTクレームに ``** を必須**。
- **サーバ/決済Webhook**: `service_role`（サーバキー）で実行。
- **匿名(anon)**: 書込み禁止。読み取りは必要最小限のみ（原則0）。

> すべての「店舗スコープ」テーブルは `store_id uuid` を持つこと。

---

## 3. 権限（GRANT/REVOKE）方針

- `authenticated` に対象テーブルの `SELECT, INSERT, UPDATE, DELETE` のみ付与。
- `anon` と `public` からは `INSERT/UPDATE/DELETE` を剥奪。
- すべて**冪等**（何度流しても同じ状態に収束）のSQLで管理。

### 標準スニペット（orders 例）

```sql
-- スキーマ使用
GRANT USAGE ON SCHEMA public TO authenticated;

-- 基本4操作
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;

-- シーケンス（必要時）
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 過剰権限の剥奪
REVOKE ALL ON public.orders FROM public, anon;

-- 匿名書込みの完全OFF（保険）
DROP POLICY IF EXISTS orders_insert_anon ON public.orders;
REVOKE INSERT ON public.orders FROM anon;
```

---

## 4. RLS（行レベルセキュリティ）標準

- **フラグ**: `ENABLE` + `FORCE` を常時維持。
- **原則**: 「JWTの `store_id` = 行の `store_id`」のときのみ許可。

### 標準ポリシー（orders 例）

```sql
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;

-- SELECT
DROP POLICY IF EXISTS orders_select ON public.orders;
CREATE POLICY orders_select ON public.orders
  FOR SELECT TO authenticated
  USING ((current_setting('request.jwt.claims', true)::json->>'store_id')::uuid = store_id);

-- INSERT（自店舗行のみ挿入可）
DROP POLICY IF EXISTS orders_insert ON public.orders;
CREATE POLICY orders_insert ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK ((current_setting('request.jwt.claims', true)::json->>'store_id')::uuid = store_id);

-- UPDATE（自店舗行のみ）
DROP POLICY IF EXISTS orders_update ON public.orders;
CREATE POLICY orders_update ON public.orders
  FOR UPDATE TO authenticated
  USING     ((current_setting('request.jwt.claims', true)::json->>'store_id')::uuid = store_id)
  WITH CHECK((current_setting('request.jwt.claims', true)::json->>'store_id')::uuid = store_id);

-- DELETE（必要に応じて状態条件を追加）
DROP POLICY IF EXISTS orders_delete ON public.orders;
CREATE POLICY orders_delete ON public.orders
  FOR DELETE TO authenticated
  USING ((current_setting('request.jwt.claims', true)::json->>'store_id')::uuid = store_id);
```

---

## 5. 列レベル制御（UPDATE制限）

- **列権限**で「更新できる列」を最小化（RLSと独立に効く）。
- 例: 店舗は `status, fulfilled_at, note` のみ更新可。

```sql
REVOKE UPDATE ON public.orders FROM authenticated;                      -- いったん全剥がし
GRANT  UPDATE (status, fulfilled_at, note) ON public.orders TO authenticated;  -- 許可列のみ
```

- **不変列のバックストップ**をトリガーで追加（例: `store_id`, `code`, `total`）。

---

## 6. トリガー設計

### 6.1 不変列ガード

- 目的: 重要列が誤って変更される事故をDBで拒否。
- 対象候補: `store_id`, `code`, `total` など。

（関数・トリガーは別紙SQLにて提供）

### 6.2 状態遷移ガード

- 正規遷移: ``
- 権限分離:
  - `service_role`: `PENDING → PAID` のみ可（決済Webhook）
  - `authenticated`（店舗）: `PAID → FULFILLED` のみ可
  - 同値遷移は許可。それ以外は拒否。

（関数・トリガーは別紙SQLにて提供）

### 6.3 挿入時の `store_id` 自動補完

- 目的: アプリ側の実装ミス（`store_id` 抜け）を吸収。
- 仕様: `NEW.store_id` がNULLならJWTの `store_id` を自動セット。

（関数・トリガーは別紙SQLにて提供）

---

## 7. RLSの他テーブル横展開テンプレ

- 対象: `products`, `items`, `customers`, `order_items` など「店舗スコープ」を持つ全テーブル。
- 方針: 4章のポリシーをテーブル名だけ差し替えて適用。
- 可能なら **共通DDLテンプレ**を用意し、テーブル作成時に自動適用。

---

## 8. ストレージ/Realtime/RPC の境界

- **ストレージ（画像バケット）**:
  - オブジェクトメタに `store_id` を持たせる or パス命名規約 `/stores/<store_id>/...`
  - 署名付きURLは短寿命。RLS同等のチェック（Storageポリシー）を適用。
- **Realtime**:
  - サブスクは**自店舗の行のみ**にフィルタ。
  - `REPLICA IDENTITY FULL` を必要テーブル（`orders` 等）に設定し差分の不一致を防止。
- **RPC/Edge Functions**:
  - `service_role` 専用と `authenticated` 専用を分離。
  - 関数内部でも `request.jwt.claims` を検査し**越境を拒否**。

---

## 9. 運用（監査・バックアップ・ロールバック）

- **監査**:
  - 誰が/いつ/何を/どう変えたかのログ化（最低: アプリ側で操作ログ、可能ならDB監査拡張）。
- **バックアップ**:
  - スキーマ（テーブル定義・RLS・トリガー）を日次ダンプ。
  - 重要関数/ポリシーはGitでIaC管理（.sqlをリポジトリで版管理）。
- **即時ロールバック手順**:
  - 一時停止: `ALTER TABLE ... DISABLE ROW LEVEL SECURITY;`
  - ポリシー全削除: `SELECT format('DROP POLICY %I ON public.orders;', policyname) FROM pg_policies ... \gexec`
  - バックアップ抜粋の適用で復旧。

---

## 10. 検証チェックリスト（抜粋）

1. **RLSフラグ**

```sql
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='orders';
```

2. **ポリシー一覧**

```sql
SELECT policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname='public' AND tablename='orders'
ORDER BY policyname;
```

3. **権限確認**

```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='orders';
```

4. **越境不可テスト**（A店JWTでB店行が見えない/更新できない）
5. **列制限テスト**（許可列のみ更新可、禁止列でエラー）
6. **状態遷移テスト**（正規経路のみ成功）

---

## 11. 導入ステップ（小刻み運用）

- **Step 1**: 匿名書込みの完全OFF（完了前提）
- **Step 2**: `authenticated` 基本権限の最小化（GRANT/REVOKE）
- **Step 3**: RLSポリシーの再点検（`store_id`一致のみ）
- **Step 4**: 列レベルUPDATEの絞り込み（許可列だけGRANT）
- **Step 5**: 不変列ガード・挿入自動補完トリガー
- **Step 6**: 状態遷移ガード（ロール別に許可）
- **Step 7**: 他テーブルへ横展開（テンプレ適用）
- **Step 8**: ストレージ/Realtime/RPCの境界整理
- **Step 9**: 監査/バックアップ/ロールバック運用の定着

---

## 12. 付録：ロールバック用スニペット

```sql
-- RLS 一時停止
ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;

-- orders のポリシー全削除
SELECT format('DROP POLICY %I ON public.orders;', policyname)
FROM pg_policies WHERE schemaname='public' AND tablename='orders';
\gexec
```

> 注: すべてのDDLは**冪等**で管理し、Gitにコミット。ステージング → 本番の順に適用してから切替える。

