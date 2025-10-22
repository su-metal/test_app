# 店舗参加導線・実装機能まとめ（2025 年 10 月版）

## 🎯 目的

本プロジェクトでは「LINE ミニアプリを通じて、店舗がスムーズに参加・運用できる仕組み」を実装することを目的とした。  
参加店舗が独自に管理画面を持ち、受取時間や在庫などを自律的に設定できるようにする。

---

## 🏗 全体構成

- **環境**: Next.js App Router（Monorepo 構成）
- **サーバー**: Supabase（Auth + Database + Storage）
- **クライアント**:
  - ユーザー側（LINE ミニアプリ）
  - 店舗側（管理・登録アプリ）

---

## 🪧 店舗参加の導線（フロー概要）

1. **申請フォーム入力（店舗申請）**

   - 一般店舗が参加申請を送信。
   - フォーム送信先: `/store/applications`
   - 申請内容は `public.store_applications` テーブルに保存。

2. **管理者承認フロー**

   - 管理画面 `/admin/applications` にて、申請リストを表示。
   - 管理者が「承認」ボタンを押すと次の処理が自動実行される:
     - `auth.admin.createUser()` により **店舗用ユーザー** を Supabase Auth に作成。
     - 該当店舗情報が `public.stores` に登録される。
     - 店舗の初期状態（pickup プリセット・設定値など）を自動生成。
   - 登録完了後、店舗には「ログイン用メール」が送信される（初期 PW 設定可）。

   -初期パスワード:password = "Passw0rd!"

3. **店舗ログイン**

   - `/login` ページで Email/Password によるサインイン。
   - 成功後は `/`（トップ画面）へ遷移。
   - App Router 版 `useRouter().replace('/')` にてリダイレクト処理。

4. **ダッシュボード・店舗設定**

   - ログイン後のトップで、以下の管理項目を操作可能：
     - 店舗情報（店名・説明文・住所）
     - 営業時間・受取時間設定
     - 商品登録・在庫更新
     - 注文履歴確認
   - 各項目は Supabase 上の該当テーブル（`stores`, `store_pickup_presets`, `store_items` など）に反映される。

5. **LINE ミニアプリ連携**
   - ユーザー側は LINE ミニアプリ上で店舗を閲覧・注文可能。
   - 店舗側は同ミニアプリを通じてサインイン不要で管理（LIFF ID トークンによるサイレント認証）。

---

## ⚙ 実装された主要機能

### 1. 店舗申請フォーム

- `/store/applications` で店舗登録申請を受け付け。
- バリデーション後、`store_applications` テーブルに INSERT。

### 2. 管理者承認 API

- パス: `/api/admin/approve-store`
- 実行内容:
  - 店舗申請データからユーザーを作成 (`auth.admin.createUser`)。
  - 新規店舗を `public.stores` に登録。
  - `auth_user_id` カラムを紐づけ。
  - 既存店舗には `store_pickup_presets` の初期プリセットを生成。

### 3. Supabase Auth 管理拡張

- `apps/store/src/app/api/dev/set-password/route.ts` に開発用 API を実装。
  - service_role キーを利用して管理者が任意のユーザーのパスワードを再設定可能。
  - 開発時のみ有効（`ADMIN_DASHBOARD_SECRET` による制御）。

### 4. 店舗ログインとリダイレクト修正

- 旧仕様では `/dashboard` へ遷移 → 新仕様で `/` に統一。
- コード修正例:
  ```diff
  - const next = new URLSearchParams(location.search).get('next') || '/dashboard';
  + const next = new URLSearchParams(location.search).get('next') || '/';
  ```
- `router.replace('/')` でシームレスな SPA 遷移に変更。

### 5. 受取時間プリセット機能（store_pickup_presets）

- API パス: `/api/presets/upsert`
- 機能概要:
  - **LIFF ID トークンによるサイレント認証**（LINE ミニアプリ用）
  - **service_role キーで upsert**（RLS を回避）
  - 新規・更新両対応 (`onConflict: 'store_id,slot_no'`)
- クライアント側:
  - `upsertPickupPresetsViaApi(presets)` で API 経由保存。
  - 開発時は `NEXT_PUBLIC_DEV_SKIP_LIFF=1` により Supabase SDK 経由にフォールバック。

### 6. RLS (Row Level Security) 設計

- `store_pickup_presets`, `stores`, `store_applications` などにポリシー設定。
- ポリシー条件:
  - 開発モード: `auth.uid() = stores.auth_user_id`
  - 本番モード: service_role 経由で API が実行されるためポリシーを通過。

### 7. 店舗メンバー権限 (`store_members`)

- 店舗オーナー以外の共同管理者を想定。
- テーブル: `store_members (store_id, line_user_id, role)`
- `/api/presets/upsert` にて `store_members` の一致確認で編集権限を許可。

---

## 🔐 環境変数整理

| 環境変数名                                  | 用途                                 | スコープ     |
| ------------------------------------------- | ------------------------------------ | ------------ |
| `NEXT_PUBLIC_SUPABASE_URL`                  | Supabase 接続先                      | 共通         |
| `SUPABASE_SERVICE_ROLE_KEY`                 | service_role キー（サーバー API 用） | サーバー     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`             | anon キー（クライアント用）          | クライアント |
| `NEXT_PUBLIC_LIFF_ID`                       | LIFF アプリ識別 ID                   | クライアント |
| `LINE_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_ID` | LIFF トークン検証用                  | サーバー     |
| `NEXT_PUBLIC_DEV_SKIP_LIFF`                 | 開発モードで LIFF をスキップ         | クライアント |
| `ADMIN_DASHBOARD_SECRET`                    | 開発専用 API の認証シークレット      | サーバー     |

---

## ✅ 完了した要件まとめ

| 機能                   | 状態 | 備考                                |
| ---------------------- | ---- | ----------------------------------- |
| 店舗申請フォーム       | ✅   | store_applications テーブル連携済   |
| 管理者承認フロー       | ✅   | approve-store API 実装済            |
| 初期 PW 設定 / 再発行  | ✅   | dev/set-password ルートで再設定可能 |
| ログイン画面修正       | ✅   | 遷移先 `/` に統一                   |
| LIFF サイレント認証    | ✅   | `/api/presets/upsert` に統合        |
| RLS 違反解消           | ✅   | service_role 経由に統一             |
| store_members 権限     | ✅   | 実装・API 対応済                    |
| 開発時の LIFF スキップ | ✅   | NEXT_PUBLIC_DEV_SKIP_LIFF=1         |
| Supabase との整合      | ✅   | すべての RLS・キー検証済み          |

---

## 📈 今後の拡張案

- 店舗の **商品メニュー管理** を API 分離（`/api/items/upsert`）化。
- 管理者パネルに「申請履歴」「参加店舗の稼働状況」を可視化。
- LIFF サイレント認証と Supabase Auth の連携を完全自動化。
- store_members によるロール別アクセス制御（admin / staff）を追加。

---

**最終更新:** 2025-10-22  
**作成者:** アプリ開発支援チーム（LINE ミニアプリ統合対応版）
