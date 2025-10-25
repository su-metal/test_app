# 店舗ごとのシンプルログイン運用（store）

- 1セッション=1店舗 固定。店舗切替は再ログインのみ。
- セッションCookie: `store_session`（HttpOnly; Secure; SameSite=Lax; Path=/）。内容は `{ sub, iat, store_id? }` をHMAC署名。
- 環境変数: `STORE_SESSION_SECRET` を優先使用（なければ従来の `ADMIN_DASHBOARD_SECRET`/`LINE_LOGIN_CHANNEL_SECRET`）。

## フロー
- `/api/auth/login/password` 認証成功時:
  - 単一所属 → `store_id` を入れて `store_session` を発行。
  - 複数所属 → `store_id` なしで発行し `need_store_select` を返す → `/select-store` で店舗選択。
- `/api/auth/session/select-store` で店舗選択確定（所属検証あり）→ `store_session` を再発行。
- `/api/auth/session/set-store` は 405 固定（無効化）。

## ルート保護/認可
- ページ保護は `middleware.ts`（未ログインは `/login` へ）。
- サーバーAPIは共通ポリシー:
  - セッションなし → 401 `unauthorized`
  - `store_id` 未設定 → 400 `store_not_selected`
  - 対象レコードの `store_id` と不一致 → 403 `forbidden:store-mismatch`
  - 書き込み時は `store_id = session.store_id` をサーバー側で強制。

## UI
- StoreSwitcher は無効化し、クリック時に「店舗を変更するには一度ログアウトして、別店舗でログインしてください」を表示。
- 成功トーストは API 200 のみ表示（例: 受取時間プリセット）。

## 変更点（抜粋）
- 無効化: `apps/store/src/app/api/auth/session/set-store/route.ts` → 405 固定。
- 追加: `/api/auth/session/list-stores`, `/api/auth/session/select-store`。
- 認可強化: 画像アップロード/削除、受取時間プリセット、受取完了API。
- ブリッジ変更: `layout.tsx` から `__STORE_ID__` の localStorage 読み込みを撤廃。`SupabaseBoot` が `/api/auth/session/inspect` を参照して反映。

## TODO(req v2)
- 鍵ローテーション/署名方式の正式化。
- 複数所属ユーザーのUX詳細（ヘルプ、戻る導線）。

