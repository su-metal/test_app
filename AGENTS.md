プロジェクト エージェント ガイド

概要

- pnpm Workspaces によるモノレポ。2 つの Next.js（App Router）アプリが 1 つの Supabase を共有します。
- アプリ
  - apps/store: 店側の UI。注文一覧、受け渡し（FULFILLED への更新）など。
  - apps/user: ユーザー側の UI。閲覧・注文・チケット表示など。
- 言語/UX: 日本語が既定。UI の文言は日本語で統一してください。

要件準拠方針（重要）

- 正式要件は「フードロス削減アプリ*要件・仕様書\_v_2*（2025-09-26）」に従います（以降「要件書」）。
- 現状はテスト運用のため、機能を限定したテストアプリとして実装します。制限がある場合でも、要件書の仕様と矛盾しない設計（型・イベント・命名・状態遷移）に揃えてください。
- 実装で要件と差分が出る場合は、コード内コメントに「TODO(req v2): …」を残し、将来の拡張点を明示してください（大規模コメントは避ける）。
- ステータスや文言は要件書の表記に寄せ、既存 UI の日本語表現と齟齬が出ないよう統一します。

ワークスペースとツール

- パッケージマネージャ: pnpm（workspaces 有効）。
- ルートスクリプト
  - `pnpm dev`: 2 アプリを同時起動（store: :3001、user: :3002）。
  - `pnpm dev:store` / `pnpm dev:user`: 個別起動。
- フレームワーク/ライブラリ（特記ない限りルート管理）
  - next 15.5.x（App Router）、react 19、react-dom 19。
  - @supabase/supabase-js ^2.74（ルート依存、両アプリが使用）。
  - Tailwind CSS 4 + PostCSS + Autoprefixer。
- TypeScript
  - strict 有効、`skipLibCheck` true、bundler module resolution。
  - パスエイリアス: 各アプリ内で `@/*` → `./src/*`。

環境変数

- 必須（必要に応じてルートや各アプリの `.env.local` に配置）
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_STORE_ID`（文字列。UUID 推奨）
- store アプリは `apps/store/src/app/layout.tsx` で env を `window` へブリッジし、クライアント専用コードから読めるようにしています。
- store / user 間で値の不整合があると Realtime 同期が壊れます。必ず同一プロジェクト/同一 STORE_ID を指すこと。

Supabase 連携

- Store（apps/store）
  - 受け渡し: `supabase.from('orders').update({ status: 'FULFILLED' })...`。
  - `SupabaseBoot.tsx` で env を `window` に設定し、クライアントを遅延生成。
  - ステータス: `PENDING | FULFILLED`。
- User（apps/user）
  - 初回利用時に Supabase クライアントを単一生成。
  - `public.orders` の `postgres_changes` を購読し、店側のステータスをユーザー側に変換:
    - FULFILLED/REDEEMED/COMPLETED → `redeemed`
    - PAID/PENDING → `paid`
  - Realtime 不達対策としてポーリング（`id, code, status` の取得）で整合も行います。

テスト運用における縮退（要件書との主な差分）

- 認証・会員管理: 現段階では匿名ユーザー前提。将来は要件書に従い Supabase Auth 等で拡張。
- 決済: テストカードによる疑似決済ロジック（apps/user）。本番決済は未実装。
- 通知: ブラウザ内トーストのみ。外部通知（メール/SMS/Push）は未実装。
- 在庫: 店側 UI 操作と簡易同期で運用。外部在庫システム連携は未実装。
- 監査ログ/分析: ローカル簡易ログのみ。サーバー転送/可視化は未実装。

チケットとコード照合

- ユーザー側の注文は 6 桁コード `code6` を保持。DB は `orders.code` を持ちます。
- 照合ポリシー（厳密）: 両者とも 6 桁正規化後に完全一致で比較。
  - `normalizeCode6(value)` で非数字を除去し、6 桁にゼロ埋め。
  - 可能なら `id` の完全一致も併用。
- 店側が受け渡し済みにすると、ユーザー側は該当注文を `redeemed` に更新し、「未引換のチケット」から除外。重複は `code6` をキーに `redeemed` を優先して 1 件化します。

用語・状態の対応（要件書との整合）

- 店側（DB）: `PENDING`（受取待ち）, `FULFILLED`（受け渡し済み）
- ユーザー側（UI）: `paid`（未引換）, `redeemed`（引換済み）, `refunded`（返金済み・将来）
- ドキュメント/表示:
  - `paid` → 「未引換」
  - `redeemed` → 「引換済み」
  - `FULFILLED` → 店側の受け渡し操作で設定される終状態（ユーザー側は `redeemed` と同義）

アプリ構成の要点

- apps/store
  - `src/app/layout.tsx`: env を `window` へブリッジ、グローバルスタイル。
  - `src/app/page.tsx`: 店 UI の中核（商品 CRUD、注文一覧、受け渡し、在庫連携など）。
  - `src/types/window.d.ts`: Window 拡張。
  - 店舗スイッチャー: ヘッダー右上のセレクタで `stores` から選択。選択結果は `localStorage('store:selected')` に保存され、`window.__STORE_ID__` に反映されます（リロードで全データが切替）。
- apps/user
  - `src/app/page.tsx`: ユーザーフローの中核（ショップ/カート/注文/アカウント、Realtime + ポーリング、トースト、QR 等）。
  - `src/app/layout.tsx`: フォント/グローバルスタイル。
  - `src/lib/supabase.ts`: 簡易クライアント（page.tsx 側のシングルトンも参照）。
  - 店舗・商品取得: `stores`（全件）と `products` を読み込み、`store_id` でグルーピングして `shops` を構築（テスト段階では店舗は DB 由来、商品の全店対応は段階的に移行）。

実行とビルド

- 開発: `pnpm i` → `pnpm dev`。 http://localhost:3001（store）/ http://localhost:3002（user）。
- 本番: 各アプリで `build` / `start` を使用。

フェーズ方針（テスト → 正式）

- Phase 0（現状・テスト運用）
  - 最小フロー: 商品一覧 → カート → 注文 → 店側で受け渡し → ユーザー側で「引換済み」反映。
  - Realtime が不安定な環境でも整合が取れるよう、ユーザー側でポーリングのフェールセーフを有効化。
- Phase 1（要件書準拠の拡張）
  - 認証/ユーザープロファイル、正式決済、通知、在庫連携、運用メトリクスなどを順次実装。
  - 実装順は要件書の優先度に従い、DB スキーマ変更はマイグレーション前提で計画。

コーディング規約（必ず遵守）

- 変更は最小限・局所的に。無関係ファイルの整形はしない。
- TypeScript 型を維持。やむを得ない場合を除き `any` は避ける。
- Next.js App Router
  - クライアントコンポーネントは先頭に `"use client"`。
  - クライアントでは Node 専用 API を使わない。
- UI 文言は日本語で統一。簡潔なラベルを心がける。
- ユーザー側ステータス表記
  - `paid` → 「未引換」、`redeemed` → 「引換済み」、`refunded` → 「返金済み」。
- 6 桁コード比較は必ず `normalizeCode6` を使うこと。

Realtime とポリシーのチェックリスト（同期トラブル時）

- Supabase Realtime を `public.orders` に対して有効化しているか。
- 必要なら DB 側で `ALTER TABLE public.orders REPLICA IDENTITY FULL;`。
- RLS: anon ロールが Realtime/ポーリングに必要な `select` を許可されているか。
- 両アプリが同一 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_STORE_ID` を参照しているか。

要件書の参照と作業ルール

- 正式要件ドキュメント名: `フードロス削減アプリ_要件・仕様書_v_2_（2025_09_26）`
- 本レポジトリ外のドキュメントで管理されています。参照時は担当者が最新版を確認してください。
- 実装の判断が分かれる場合は、要件書の記述を優先しつつ、現行テスト運用の制約内で実現可能な最小案を提案し、差分を `TODO(req v2)` で残します。

新規コードの追加先

- 店側機能: 基本は `apps/store/src/app/page.tsx`（必要なら新規ルート）。
- ユーザー側機能: `apps/user/src/app/page.tsx`（単一画面）または `src/lib/*` に分離。
- 共有ユーティリティ: `packages/shared`（現状空）。共通化する場合は TS パスエイリアスを調整。

テストとバリデーション

- ローカルでの対象検証を優先（例: 受け渡し → 数秒内に user 側が更新/整合するか）。
- 新しいテストツール/設定は要求がない限り追加しない。

よくある落とし穴

- env 不整合により Realtime が届かず「未引換」に残る。
- 正規化せずコードを比較して不一致扱いになる。
- SSR/CSR の時刻差でハイドレーションずれ。時間表示はマウント確認で対策。

コード上の連絡ポイント（アンカー）

- User: 注文整合と UI
  - `apps/user/src/app/page.tsx`: コード正規化、Realtime 購読、ポーリング、アカウント表示。
- Store: 受け渡しと env ブート
  - `apps/store/src/app/page.tsx`: 受け渡し処理と在庫更新。
  - `apps/store/src/app/layout.tsx`: env を `window` へ露出。

Supabase データベース構成（現行実装に基づく）

- スキーマ: `public`
- テーブル: `stores`

  - `id` uuid/text: 店舗固有識別 ID（uuid 推奨）。
  - `name` text: 店舗名（リクエスト記載は text/uuid だが text に統一）。
  - `created_at` timestamptz: 作成日時（NOTE: ドキュメント表記は `timestampz` だが `timestamptz` が正）。
  - `lat` float8: 店舗緯度。
  - `lng` float8: 店舗経度。
  - インデックス: `id`（PK）。
  - 関連: `products.store_id` / `orders.store_id` と論理的に紐付く（外部キーは運用要件に応じて付与）。

- テーブル: `products`

  - `id` text/uuid: 主キー（文字列として扱えること）。
  - `store_id` text/uuid: 店舗識別子（必須）。`NEXT_PUBLIC_STORE_ID` と一致で絞り込み。
  - `name` text: 商品名。
  - `price` numeric: 単価（円）。
  - `stock` integer: 在庫数（0 以上）。
  - `updated_at` timestamptz: 更新日時（可能なら DEFAULT now() + 更新トリガ）。
  - インデックス: `store_id`, `stock`（在庫あり絞り込み用）。

- テーブル: `orders`

  - `id` uuid/text: 主キー。store 側は uuid 前提で更新、user 側は返値が無い場合 `oid` を暫定使用する実装あり（将来統一）。
  - `store_id` text/uuid: 店舗識別子（必須）。
  - `code` text: 6 桁コード（UI 側は `normalizeCode6` で比較）。
  - `customer` text null: 顧客表示名（匿名可）。
  - `items` jsonb null: 注文明細配列（`[{ id, name, qty, price }]`）。
  - `total` numeric null: 合計金額。
  - `placed_at` timestamptz null: 受付時刻（DEFAULT now() 推奨）。
  - `status` text: 店側は `PENDING`/`FULFILLED` を使用。
  - インデックス: `store_id`, `status`, `code`。
  - Realtime: `postgres_changes (UPDATE)` を有効化。`REPLICA IDENTITY FULL` 推奨。

- RLS/ポリシー（最小）

  - anon で `products`/`orders` の必要な範囲の `select` を許可。
  - `orders` の更新は店側アプリ（store）からのみ行う想定。必要に応じて `eq(store_id, :store)` 条件を課す。

- 既知の差分吸収（互換）
  - 在庫列名のゆらぎ: user 側は `stock ?? quantity ?? stock_count` を吸収。DB は最終的に `stock` に統一してください。
  - `orders.id` の型: uuid 推奨。UI 側は文字列で扱えるため text でも動作しますが、将来は uuid で統一。
  - `orders.status` の値: 店側 `PENDING`/`FULFILLED`、ユーザー側 UI は `paid`/`redeemed` にマップして表示。

注意

- 本記述は現行コードの参照カラムに基づくものです。提供された「データベース構成（supabase）\_2025_10_10.m

**ルール:** 各コマンドでは「定義 → 使用」。`$` はエスケープしない。汎用的な `'path/to/file.ext'` を使う。

---

## 1) 読み取り（UTF-8 BOM なし、行番号付き）

````bash
bash -lc 'powershell -NoLogo -Command "
$OutputEncoding = [C**Rule:** In each command, **define → use**. Do **not** escape `$`. Use generic `'path/to/file.ext'`.

---

## 1) READ (UTF‑8 no BOM, line‑numbered)

```bash
bash -lc 'powershell -NoLogo -Command "
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
Set-Location -LiteralPath (Convert-Path .);
function Get-Lines { param([string]$Path,[int]$Skip=0,[int]$First=40)
  $enc=[Text.UTF8Encoding]::new($false)
  $text=[IO.File]::ReadAllText($Path,$enc)
  if($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF){ $text=$text.Substring(1) }
  $ls=$text -split "`r?`n"
  for($i=$Skip; $i -lt [Math]::Min($Skip+$First,$ls.Length); $i++){ "{0:D4}: {1}" -f ($i+1), $ls[$i] }
}
Get-Lines -Path "path/to/file.ext" -First 120 -Skip 0
"'
````

---

## 2) WRITE (UTF‑8 no BOM, atomic replace, backup)

```bash
bash -lc 'powershell -NoLogo -Command "
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
Set-Location -LiteralPath (Convert-Path .);
function Write-Utf8NoBom { param([string]$Path,[string]$Content)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = [IO.Path]::GetTempFileName()
  try {
    $enc = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($tmp,$Content,$enc)
    Move-Item $tmp $Path -Force
  }
  finally {
    if (Test-Path $tmp) {
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}
$file = "path/to/your_file.ext"
$enc  = [Text.UTF8Encoding]::new($false)
$old  = (Test-Path $file) ? ([IO.File]::ReadAllText($file,$enc)) : ''
Write-Utf8NoBom -Path $file -Content ($old+"`nYOUR_TEXT_HERE`n")
"'
```

$file -Content ($old+"`nYOUR_TEXT_HERE`n")
"'

```
 $file -Content ($old+"`nYOUR_TEXT_HERE`n")
"'
```

$file -Content ($old+"`nYOUR_TEXT_HERE`n")
"'

```

```

\n+**補助ドキュメント（/dogs）**

- リポジトリ直下の `/dogs` 配下にあるドキュメントは、作業時に適宜参照してよいものとします。
- ただし記載が要件書や本ガイドと矛盾する場合は、正式要件（フードロス削減アプリ\_要件・仕様書\_v_2）を優先し、差分はコード内に `TODO(req v2): …` を残してください。
- 適用スコープは `/dogs` ディレクトリ以下のすべてのファイルです。
