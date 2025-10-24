プロジェクト エージェント ガイド

概要

- pnpm Workspaces によるモノレポ。2 つの Next.js（App Router）アプリが 1 つの Supabase を共有します。
- アプリ
  - apps/store: 店側の UI。注文一覧、受け渡し（FULFILLED への更新）、簡易分析（`src/app/analytics/page.tsx`）。
  - apps/user: ユーザー側の UI。閲覧・注文・チケット表示・地図表示など。
- 言語/UX: 日本語が既定。UI の文言は日本語で統一してください。

要件準拠方針（重要）

- 正式要件は「フードロス削減アプリ 要件・仕様書_v_2（2025-09-26）」に従います（以降「要件書」）。
- 現状はテスト運用のため、機能を限定したテストアプリ。差分が出る場合も要件書と矛盾しない設計（型・イベント・命名・状態遷移）に揃えること。
- 要件との差分はコード内に「TODO(req v2): …」で最小限コメントを残すこと。
- ステータスや文言は要件書の表記に寄せ、既存 UI の日本語表現と齟齬が出ないよう統一。

ワークスペースとツール

- パッケージマネージャ: pnpm（workspaces 有効）。
- ルートスクリプト
  - `pnpm dev`: 2 アプリ同時起動（store: :3001、user: :3002）。
  - `pnpm dev:store` / `pnpm dev:user`: 個別起動。
- フレームワーク/ライブラリ（特記ない限りルート管理）
  - next 15.5.x（App Router）、react 19.1.x、react-dom 19.1.x。
  - `@supabase/supabase-js` ^2.74（ルート依存、両アプリで使用）。
  - Tailwind CSS 4 + PostCSS + Autoprefixer。
- TypeScript
  - strict 有効、`skipLibCheck` true、`moduleResolution: bundler`。
  - パスエイリアス: 各アプリ内で `@/*` → `./src/*`。

環境変数

- 必須（必要に応じてルートや各アプリの `.env.local` に配置）
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_STORE_ID`（文字列。UUID 推奨）
- store は `apps/store/src/app/layout.tsx` で env を `window` にブリッジし、クライアント専用コードから読めます。
- store / user で値が不整合だと Realtime 同期が壊れます。必ず同一プロジェクト/同一 STORE_ID を指すこと。
- LINE/LIFF（運用/検証で利用。存在する場合のみ）
  - `NEXT_PUBLIC_LIFF_ID`
  - `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`（Webhook 応答用）
  - `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`（store 側 silent-login 用）

Supabase 連携

- Store（apps/store）
  - 受け渡し: `supabase.from('orders').update({ status: 'FULFILLED' })...`。
  - `SupabaseBoot.tsx` で env を `window` に設定し、クライアントを遅延生成。
  - ステータス: `PENDING | FULFILLED`。
- User（apps/user）
  - 初回利用時に Supabase クライアントを単一生成（`src/lib/supabase.ts`）。
  - `public.orders` の `postgres_changes` を購読し、店側ステータス → ユーザー側に変換:
    - FULFILLED/REDEEMED/COMPLETED → `redeemed`
    - PAID/PENDING → `paid`
  - Realtime 不達対策としてポーリング（`id, code, status`）で整合。

Realtime とポリシーのチェックリスト

- `public.orders` に対し Realtime を有効化。
- 必要なら `ALTER TABLE public.orders REPLICA IDENTITY FULL;`。
- RLS: anon ロールに `products`/`orders` の必要な `select` を許可。
- 両アプリが同一 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_STORE_ID` を参照。

テスト運用における縮退（要件書との差分）

- 認証: 現段階では匿名ユーザー前提。将来は Supabase Auth 等で拡張。
- 決済: テストカードによる疑似決済（apps/user）。本番決済は未実装。
- 通知: ブラウザ内トーストのみ（外部通知は未実装）。
- 在庫: 店側 UI 操作と簡易同期。外部在庫システム連携は未実装。
- 監査ログ/分析: ローカル簡易ログのみ。サーバー転送/可視化は未実装。

チケットとコード照合

- ユーザー側の注文は 6 桁コード `code6` を保持。DB は `orders.code`。
- 照合ポリシー（厳密）: 双方とも 6 桁正規化後に完全一致で比較。
  - `normalizeCode6(value)` で非数字を除去し 6 桁にゼロ埋め。
  - 可能なら `id` の完全一致も併用。
- 店側が受け渡し済みにすると、ユーザー側は該当注文を `redeemed` に更新し、「未引換」から除外。重複は `code6` をキーに `redeemed` を優先して 1 件化。

用語・状態の対応（要件書との整合）

- 店側（DB）: `PENDING`（受取待ち）, `FULFILLED`（受け渡し済み）
- ユーザー側（UI）: `paid`（未引換）, `redeemed`（引換済み）, `refunded`（返金済み・将来）
- 表示文言: `paid` → 「未引換」、`redeemed` → 「引換済み」

アプリ構成の要点

- apps/store
  - `src/app/layout.tsx`: env を `window` へブリッジ、グローバルスタイル。
  - `src/app/page.tsx`: 店 UI（商品 CRUD、注文一覧、受け渡し、在庫連携）。
  - `src/app/analytics/page.tsx`: 簡易分析画面（存在する場合）。
  - `src/types/window.d.ts`: Window 拡張。
  - 店舗スイッチャー: ヘッダー右上セレクタ。`localStorage('store:selected')` に保存し `window.__STORE_ID__` に反映。
  - LIFF 起動（任意）: `src/app/LiffBoot.tsx`。
- apps/user
  - `src/app/page.tsx`: ユーザーフロー（ショップ/カート/注文/アカウント、Realtime + ポーリング、トースト、QR 等）。
  - `src/app/layout.tsx`: フォント/グローバルスタイル。`<LiffBoot />` を含む。
  - `src/lib/supabase.ts`: クライアント単一生成。
  - `src/components/MapView.tsx` / `MapEmbedWithFallback.tsx`: 地図/埋め込み。
  - 受け取り時間: UI `src/components/PickupTimeSelector.tsx`、ロジック `src/lib/pickupSlots.ts`。
  - LIFF 起動（任意）: `src/app/LiffBoot.tsx`。

API/機能の配置（user）

- Stripe 関連 API:
  - `apps/user/src/app/api/stripe/create-checkout-session/route.ts`
  - `apps/user/src/app/api/stripe/create-intent/route.ts`
  - `apps/user/src/app/api/stripe/checkout/route.ts`
  - `apps/user/src/app/api/stripe/fulfill/route.ts`
  - `apps/user/src/app/api/stripe/pay-with-saved/route.ts`
  - `apps/user/src/app/api/checkout/embedded/route.ts`
  - `apps/user/src/app/api/create-checkout-session/route.ts`（互換/移行用）
- 地図/ルーティング:
  - `apps/user/src/app/api/maps-static/route.ts`
  - `apps/user/src/app/api/osrm/route.ts`
- LINE 連携:
  - Webhook: `apps/user/src/app/api/line/webhook/route.ts`
  - LIFF: `NEXT_PUBLIC_LIFF_ID` を利用し `src/app/LiffBoot.tsx` で初期化
- 申請関連:
  - `apps/user/src/app/api/store-applications/route.ts`
- チェックアウト結果:
  - `apps/user/src/app/checkout/success/page.tsx` / `apps/user/src/app/checkout/cancel/page.tsx`

API/機能の配置（store）

- 管理・申請:
  - `apps/store/src/app/api/admin/store-applications/list/route.ts`
  - `apps/store/src/app/api/admin/approve-store/route.ts`
  - `apps/store/src/app/api/admin/tools/bootstrap-auth-users/route.ts`
  - 画面: `apps/store/src/app/api/admin/applications/page.tsx`
- 画像アップロード:
  - `apps/store/src/app/api/images/upload/route.ts`
  - `apps/store/src/app/api/images/delete/route.ts`
- LINE 認証/サインイン（silent-login）:
  - `apps/store/src/app/api/auth/line/silent-login/route.ts`
- プリセット/受け取り設定:
  - `apps/store/src/app/api/store/pickup-presets/route.ts`
  - `apps/store/src/app/api/presets/upsert/route.ts`
- 開発補助:
  - `apps/store/src/app/api/dev/set-password/route.ts`

Supabase データベース構成（現行実装に基づく）

- スキーマ: `public`
- `stores` / `products` / `orders` テーブルのカラムは本文の通り。既知の差分吸収:
  - 在庫列名のゆらぎは `stock ?? quantity ?? stock_count` を吸収（DB は最終的に `stock` に統一）。
  - `orders.id` は uuid 推奨（現状 text 互換あり）。
  - `orders.status` は店側 `PENDING`/`FULFILLED` を使用、ユーザー側 UI は `paid`/`redeemed` にマップして表示。
  - Realtime は `postgres_changes (UPDATE)` を有効化、`REPLICA IDENTITY FULL` 推奨。

ドキュメント配置（注意）

- 正式ドキュメントは `docs/` 配下を正とします。
- `document/` 配下に同名/類似ドキュメントの重複が存在しますが、整合性の観点から参照は `docs/` を優先してください（差分がある場合は要件書を優先し、必要に応じて `TODO(req v2)` を残す）。
- 旧記載の `/dogs` ディレクトリは本リポジトリに存在しないため、本ガイドから削除しました。

コーディング規約（必ず遵守）

- 変更は最小限・局所的に。無関係ファイルは触れない。
- TypeScript 型を維持。例外的事情がない限り `any` は避ける。
- Next.js App Router
  - クライアントコンポーネントは先頭に `"use client"`。
  - クライアントでは Node 専用 API を使わない。
- UI 文言は日本語で統一（「未引換」「引換済み」「返金済み」）。
- 6 桁コード比較は必ず `normalizeCode6` を使用（store/user 双方に実装あり）。

実行とビルド

- 開発: `pnpm i` → `pnpm dev`。 http://localhost:3001（store）/ http://localhost:3002（user）。
- 本番: 各アプリで `build` / `start`。

フェーズ方針（テスト → 正式）

- Phase 0（現状・テスト運用）
  - 最小フロー: 商品一覧 → カート → 注文 → 店側で受け渡し → ユーザー側で「引換済み」反映。
  - Realtime が不安定でも user 側ポーリングで整合を確保。
- Phase 1（要件書準拠の拡張）
  - 認証/ユーザープロファイル、正式決済、通知、在庫連携、メトリクスを順次実装。

注意（整合のための実装上の約束事）

- UI 文言は日本語で統一（「未引換」「引換済み」「返金済み」）。
- 6 桁コード比較は必ず `normalizeCode6` を使用（store/user 双方に実装あり）。
- Realtime が不安定な環境では user 側のポーリングで整合を取る（`id, code, status`）。
- env 不整合（URL/ANON_KEY/STORE_ID）は同期不達の主因。両アプリで同一値を必ず設定。

