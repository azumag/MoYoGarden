# セキュリティ方針

## 現在の境界

- 読み取りAPIとWebSocket観測: 公開
- Command API: `COMMAND_TOKEN`または`ADMIN_TOKEN`
- Admin API: `ADMIN_TOKEN`のみ
- `OPEN_COMMANDS`: 既定で無効
- リクエストbody: 64 KiB上限
- `REGION_IDS`: 許可領域を明示し、任意IDによるDO大量作成を防止
- Command ID: キュー済み・処理済みの冪等性チェック
- Secret: Gitへ保存しない
- ブラウザ入力token: `sessionStorage`だけに保存

localhostの`wrangler dev`は開発用としてtokenを省略できます。本番workers.dev/custom domainでは省略できません。

## 本格公開前に必要な追加

1. ユーザー認証
2. 利用者別API key / capability token
3. agentId所有権
4. Cloudflare Rate Limiting
5. IP・アカウント別quota
6. Command監査ログ
7. 重要資産操作の二段階承認
8. token revoke / ban
9. BOTランタイムの隔離
10. ワールド内テキストのprompt injection対策

## Prompt Injection

将来、看板、書籍、チャット、契約文などをLLMへ渡す場合、それらはすべて非信頼データです。

- システム方針とワールド内文章を別フィールドで渡す
- API keyやSecretをモデルへ渡さない
- LLM出力をそのまま実行せずCommand schemaへ再検証する
- 送金、組織解散、全資産移転には別ポリシーを置く
- 許可されたagentIdと予算をサーバー側で再検証する
- 自由なコード生成・実行をゲームサーバー内で許可しない

## Token運用

- 32 byte以上のランダム値を推奨
- CommandとAdminで値を分ける
- URL queryへtokenを入れない
- ログへAuthorization headerを出さない
- 漏洩時はCloudflare Dashboardで即時rotation
