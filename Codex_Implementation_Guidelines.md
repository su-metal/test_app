# Codex 実装要件書（LINEミニアプリ CSP対応・安全フォールバック）

## 目的
- LINEミニアプリ（LIFF）内で発生している **CSP 違反（外部直アクセス）を解消**する。
- 既存の UX を維持しつつ、**通常ブラウザでは現状の挙動を一切変えない**。
- Google Maps `<iframe>` は **通常通り表示**し、**LIFF 内で読み込みに失敗した時にのみ**安全な代替表示へ **自動フォールバック**する。
- 外部 API（例：OSRM など）は **同一オリジンの API ルート経由**に切り替える。

## 前提
- リポジトリは Next.js App Router 構成。主要画面は `/app/page.tsx`。
- LINE ミニアプリの CSP は **開発側で拡張不可**。クライアントからの外部直アクセスは避け、**サーバ経由（同一オリジン）**に寄せる。

## 変更対象（新規/更新するファイル）
1. **更新**: `/app/page.tsx`
2. **新規**: `/app/api/osrm/route.ts`（OSRM プロキシ）
3. **新規**: `/app/api/maps-static/route.ts`（地図画像プロキシ）
4. **新規**: `/components/MapEmbedWithFallback.tsx`（iframe＋フォールバックラッパ）
5. **新規**: `/lib/isLiffEnv.ts`（LIFF/LINE WebView 判定）
6. **任意更新**: Realtime を使っている場合のみラッパ追加（例：`/lib/realtimeLiffSafe.ts`）

## 実施手順（要件のみ）

### A. OSRM API の同一オリジン化（必須）
- `/app/api/osrm/route.ts` を作成し、OSRM へのサーバサイド fetch を実装。
- 入力パラメータのバリデーション、短期キャッシュ、タイムアウト、エラーハンドリングを行う。
- クライアント側 (`page.tsx`) の呼び出しを `/api/osrm` に変更。

### B. Google Maps `<iframe>` の“失敗時のみ”フォールバック（推奨）
- `/components/MapEmbedWithFallback.tsx` を作成。
- 既定は `<iframe>` をそのまま表示。
- **LIFF 内かつ読み込み失敗時のみ**：
  - `/api/maps-static` の静的地図画像を `<img>` で表示。
  - 「Google マップで開く」ボタンを表示（`liff.openWindow({ external: true })` 対応）。
- `/app/api/maps-static/route.ts` を追加し、鍵不要の静的タイルや Google Static Maps をサーバ側で代理取得。

### C. LIFF 判定とテスト支援
- `/lib/isLiffEnv.ts` を作成し、`navigator.userAgent` に `Line` を含む or `window.liff` で判定。
- 環境変数 `NEXT_PUBLIC_FORCE_LIFF` で強制テストモードをサポート。

### D. Realtime（該当時のみ）
- Supabase Realtime などの WebSocket を使用している場合、LIFF 環境のみポーリングに切り替えるラッパを追加。

### E. `page.tsx` の変更
- 地図部分を `MapEmbedWithFallback` に置き換える。
- OSRM 呼び出しを `/api/osrm` に切り替える。
- Realtime を使っている場合はラッパ経由に変更。

## 受け入れ基準
1. **通常ブラウザ**：
   - `<iframe>` は従来通り表示。
   - OSRM が `/api/osrm` 経由で成功し、CSP エラーが出ない。
2. **LIFF/LINE WebView**：
   - `<iframe>` が表示可能な場合はそのまま。
   - 読み込み失敗時のみ静的地図画像＋外部リンクを表示。
   - 外部 API は全て `/api/*` 経由で動作し、CSP 違反なし。
3. **Realtime（該当時のみ）**：
   - LIFF 内でポーリングへ切替、通常ブラウザでは従来の Realtime。
4. **設定・環境変数**：
   - `NEXT_PUBLIC_MAP_FALLBACK_TIMEOUT_MS`、`NEXT_PUBLIC_FORCE_LIFF`、`OSRM_BASE_URL` 等で挙動を調整可。
5. **非侵襲性**：
   - 通常ブラウザ時の UI は一切変化しない。型・戻り値の破壊的変更なし。

## 注意点
- 外部への直アクセスは禁止。同一オリジン経由に統一。
- 静的地図画像の利用規約・ライセンスに準拠。
- 例外は UI で静かにフォールバック。ログは開発時のみ詳細出力。
- `page.tsx` の責務を増やさず、コンポーネント/ライブラリ層で吸収。

## 成果物
- 上記ファイルの追加/更新。
- `.env.example` に環境変数を追記。
- README か `AGENTS.md` に実機検証手順を追記。

---
この要件どおりに、Next.js (App Router) プロジェクトで安全な CSP 対応とフォールバック処理を実装すること。
