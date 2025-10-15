# DB構成とRLSポリシー（現状まとめ / 開発メモ）

> 更新日: 現在のやり取りベース。スクショ/実行結果から確定している状態のみ記載。未確定は「推定」表記。

---

## 1. テーブル構成（把握済み）

- **public.orders**
  - 主キー: `id (uuid)`
  - 主な列: `code (text)`, `status (order_status enum)`
    - `order_status` のラベル（使用確認済み）: `PENDING`, `FULFILLED`
  - 備考: Realtime購読対象。ユーザー/店舗両アプリから参照・更新。
  - レプリカID: `FULL`（replica_identity = f）

- **public.products**
  - 詳細省略（一覧取得のログあり）。
  - レプリカID: `DEFAULT`（replica_identity = d）

- **public.stores**
  - 店舗アプリ向け。GUIから一時的に「Permissive / true」ポリシーが設定されていた履歴あり。
  - レプリカID: `DEFAULT`

---

## 2. RLS（Row Level Security）状況

### 2.1 orders テーブル
- **RLS enabled**: `true`
- **RLS forced**: `true`

#### 現在有効なポリシー（スクショ/クエリ結果より）
| policyname                    | cmd     | roles                  | using_expr | with_check |
|------------------------------|---------|------------------------|------------|------------|
| `orders_select_open`         | SELECT  | `{anon, authenticated}`| `true`     | `NULL`     |
| `orders_insert_public`       | INSERT  | `{anon, authenticated}`| `NULL`     | `true`     |
| `orders_update_by_authenticated` | UPDATE  | `{authenticated}`      | `true`     | `true`     |

> ※ 現時点で **DELETE用ポリシーは未登録**（権限も未付与）。そのため REST の `DELETE /orders` は 401/42501 になっていました。

#### 想定・運用方針（開発）
- 開発中は「履歴（引換済み）だけ anon でも削除可」にしたい場合は、次のいずれか。
  1) **一時全面開放（dev専用）**: `USING (true)` の delete ポリシーを作成。
  2) **履歴限定**: `status = 'FULFILLED'` の行のみ削除可。

> 本番は **DELETE はサーバー側ロール**（Edge Function / service_key）に寄せるのが推奨。

### 2.2 stores / products テーブル
- `stores` は GUI で **SELECT/UPDATE が `true`（Permissive）** の設定が提示されていた時期あり。
- 現在の最小方針（推定）
  - `stores`: 店舗管理者（`authenticated`）に `SELECT/UPDATE`、閲覧のみは `anon` に `SELECT` を許諾するかは仕様次第。
  - `products`: 一般公開なら `SELECT` を `anon` に許諾、管理更新は `authenticated` のみ。

---

## 3. GRANT（権限）状況

### 3.1 orders（現状）
| grantee          | privilege_type |
|------------------|----------------|
| `anon`           | SELECT, INSERT |
| `authenticated`  | SELECT, INSERT, UPDATE |

> **DELETE の GRANT は未付与** → REST の `DELETE` は RLS 以前に拒否されます。

---

## 4. REST / クライアント実装メモ

- REST 呼び出しは **必ず `apikey` と `Authorization: Bearer <anon>` を付与**。
  - 不足すると **401 Unauthorized**。
- `supabase-js` 経由で 401 が出る箇所は、独自 `fetch.js` ラッパの影響でヘッダが落ちることがあるため、
  - 重要操作（注文作成/削除）は **REST直叩きユーティリティ**を用意し、ヘッダ二重付与で回避。
- ユーザー側の表示同期
  - Realtime: `orders` の **UPDATE/DELETE** を購読し、ローカルstateから除去/更新。
  - ポーリング: `paid` だが DB に存在しない行は間引き（履歴や店舗側操作との不整合解消）。

---

## 5. いま必要な“最小修正”

### ✔ DELETE を一時的に通して動作確認（開発用）
```sql
BEGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT DELETE ON TABLE public.orders TO anon, authenticated;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_delete_relaxed ON public.orders;
CREATE POLICY orders_delete_relaxed
ON public.orders FOR DELETE TO anon, authenticated USING (true);
-- COMMIT;  -- OK時
-- ROLLBACK; -- NG時
```

### ✔ 本番に戻す（履歴のみ削除を許可）
```sql
BEGIN;
DROP POLICY IF EXISTS orders_delete_relaxed ON public.orders;
CREATE POLICY "anon can delete redeemed (dev)"
ON public.orders FOR DELETE TO anon, authenticated
USING (
  status = 'FULFILLED'::order_status
);
-- COMMIT;
```

---

## 6. 将来の整備 TODO（提案）
- **stores/products のRLS設計を明文化**（誰が読める/書ける）。
- **orders の UPDATE を店舗ロールに限定**し、ユーザーアプリは INSERT のみ（`status` 遷移は店舗側ワークフローに集約）。
- **Edge Function 経由の削除/更新**（service_key）で本番の安全性を担保。
- **Replica Identity の統一検討**: 変更トラッキング用途があれば `FULL` で揃えるかを検討。

---

### 付録：トラブルシュート早見
- 401 Unauthorized → `apikey/Authorization` 不足 or キー不一致。
- 42501 permission denied → GRANT 不足 or 該当 RLS ポリシーなし。
- enum 変換エラー（22P02） → enum列で `coalesce(status,'')` のような **空文字**比較が原因。`= ANY (...)::order_status[]` で比較。

