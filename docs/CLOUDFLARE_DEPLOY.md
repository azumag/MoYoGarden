# Cloudflare Workers Buildsによる自動デプロイ

GitHub Actionsは使用しません。CloudflareのGitHub AppとWorkers Buildsで、`main`へのpushをCloudflare側から検知してデプロイします。

## 1. GitHubリポジトリを接続

1. Cloudflare Dashboardで **Workers & Pages** を開く。
2. **Create application** からGit連携でWorkerを作成する。
3. GitHubアカウントを接続し、`azumag/MoYoGarden`だけへのアクセスを許可する。
4. 対象リポジトリとして `azumag/MoYoGarden` を選ぶ。

CloudflareアカウントへのGitHub App認可は、リポジトリから自動化できない一度だけの操作です。

## 2. Build設定

Workers Buildsへ以下を設定します。

```text
Worker name:       moyo-garden
Production branch: main
Root directory:    /
Build command:     npm run check
Deploy command:    npx wrangler deploy
```

Worker名は`wrangler.jsonc`の`name`と同じ `moyo-garden` にします。Cloudflareは通常、Workers Builds用API tokenを自動生成します。

非production branch buildは最初はOFFを推奨します。Durable Objectsを実装するWorkerには通常のpreview URLが生成されないため、preview環境は後で別Worker名・別DO namespaceとして追加します。

## 3. Runtime Secrets

Worker作成後、**Settings > Variables & Secrets** で次をSecretとして追加します。

```text
COMMAND_TOKEN = BOT・人間の通常コマンド用
ADMIN_TOKEN   = pause/reset/manual tick等の管理用
```

2つは異なる、十分に長いランダム値にしてください。これらはBuild variableではなくRuntime Secretです。

通常設定は`wrangler.jsonc`に入っています。

```text
DEFAULT_REGION_ID = garden-1
REGION_IDS         = garden-1
WORLD_SEED         = 424242
TICK_MS            = 10000
OPEN_COMMANDS      = false
```

`OPEN_COMMANDS=true`は誰でもBOTへ命令できる公開実験向けです。通常運用ではfalseのままにします。

## 4. 初回デプロイ

設定を保存してDeployします。以後、`main`へpushされるたびに次がCloudflare側で実行されます。

```text
npm install
npm run check
npx wrangler deploy
```

初回アクセス時に `garden-1` のSQLite-backed Durable Objectが初期化され、10秒後のAlarmが予約されます。

## 5. 動作確認

```bash
curl https://moyo-garden.YOUR_SUBDOMAIN.workers.dev/api/meta
curl 'https://moyo-garden.YOUR_SUBDOMAIN.workers.dev/api/health?region=garden-1'
```

ブラウザでworkers.dev URLを開くと3Dクライアントが表示されます。

## 6. カスタムドメイン

Workerの **Settings > Domains & Routes** から設定します。Static AssetsとAPIを同じオリジンで提供するため、CORSやWebSocket URLを追加変更する必要はありません。

## 7. ロールバック

Cloudflare DashboardのWorkerから過去deploymentを選び、ロールバックできます。世界状態はDurable Object SQLiteに残り、Workerコードのロールバックとは分離されています。ただし将来schema migrationを追加する場合は、後方互換性を保つ必要があります。

## 公式資料

- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
