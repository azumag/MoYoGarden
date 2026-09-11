# Cloudflare Workers Buildsによる自動デプロイ

`main` へのpushは Cloudflare の GitHub App / Workers Builds が検知して `moyo-garden` を本番へデプロイする。同時に GitHub Actions は build/test と本番commit確認を行う。

**Cloudflareのbuild成功だけ、またはGitHub Actionsのbuild成功だけでは本番反映完了とみなさない。** 完了条件は `AGENTS.md` の「本番反映の必須手順」を正本とする。

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
Build command:     npm run build
Deploy command:    npx wrangler deploy
```

`npm run build`はTypeScript型検査に加え、ブラウザ3Dクライアントと詳細モデル拡張の構文・静的検査を行います。Worker名は`wrangler.jsonc`の`name`と同じ `moyo-garden` にします。Cloudflareは通常、Workers Builds用API tokenを自動生成します。

### Build Minutes のコスト制御

`moyo-garden` は Durable Objects を持つため、feature branchをWorkers Buildsで毎回デプロイしても通常のpreview URLは得られません。Cloudflare Dashboardの **Settings > Build** は次を正本とします。

```text
Production branch:                  main
Builds for non-production branches: OFF
Build cache:                        ON
```

Build watch paths では、少なくともdeploy artifactを変えない次の変更を除外します。

```text
.github/*
docs/*
tests/*
AGENTS.md
README.md
```

`src/`、`scripts/`、`public/`、`package*.json`、`wrangler*.jsonc`、TypeScript設定はdeploy内容またはbuild生成物へ影響するため除外しません。複数種類のファイルを同じpushで変更した場合、除外対象外のファイルが1つでもあれば通常どおりbuildします。

### Cloudflare内の二重buildを防ぐ

Workers BuildsはDashboardのBuild commandを実行した後にDeploy commandを実行します。一方、`wrangler.jsonc`にもcustom build hookがあります。従来は、

1. `npm run build` → `build:web`
2. `npx wrangler deploy` → `wrangler.jsonc` の `build.command` → `build:web`

となり、同じCloudflare Build内でテスト・モデル生成・asset vendoring・検証をほぼ二重実行していました。

現在は最初の`build:web`完了時にCloudflareの`WORKERS_CI_COMMIT_SHA`だけをmarkerへ記録し、同じcommitの`wrangler deploy`では`node scripts/wrangler-build.mjs`が二度目の`build:web`をskipします。markerが無い、commitが違う、またはWorkers Builds外では従来どおり再buildするfail-safe設計です。

このdeduplicationはBranch controlの代替ではありません。feature branch buildそのものを起動しない一次対策は、引き続き **non-production branch builds=OFF** です。

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
REGION_IDS         = garden-1,garden-2,garden-3
WORLD_SEED         = 424242
TICK_MS            = 10000
OPEN_COMMANDS      = false
```

`OPEN_COMMANDS=true`は誰でもBOTへ命令できる公開実験向けです。通常運用ではfalseのままにします。

## 4. `main` push後の実行経路

`main`へpushすると、少なくとも次の2系統が動く。

### Cloudflare Workers Builds

```text
install dependencies
npm run build
npx wrangler deploy
```

`npm run build`で生成済みのartifactは同じWorkers Build commit内で再利用されるため、`wrangler deploy`のcustom build hookは同一commitの`build:web`を重複実行しない。

成功時は GitHub check `Workers Builds: moyo-garden` が success になり、Cloudflare Build ID / Version ID が記録される。

### GitHub Actions CI

`.github/workflows/ci.yml` が次を行う。

1. `Validate build`
   - dependency install
   - TypeScript
   - tests
   - browser JavaScript syntax
   - authored / PBR / Quaternius validation
2. `Verify production commit`
   - `https://moyo.bluemoon.works/api/meta` をcache-bust付きでpollする
   - `build.commit` がそのworkflowの最終SHAと一致するまで待つ
   - 一致後、`garden-1` のhealthを確認する

## 5. 本番反映の完了条件

最終 `main` commit について、以下がすべて必要。

1. `Validate build` = success
2. `Workers Builds: moyo-garden` = success
3. `/api/meta` の `build.commit` = 最終 `main` SHA
4. `/api/health?region=garden-1` = success
5. **描画/UX/LOD/model/streaming変更の場合は、本番実表示または本番配信assetでも変更を確認**

5を確認できない環境では「deploy済み・実表示確認待ち」とし、「直った」「修正完了」と断定しない。

手動確認例:

```bash
curl -H 'cache-control: no-cache' \
  'https://moyo.bluemoon.works/api/meta?verify=manual'

curl -H 'cache-control: no-cache' \
  'https://moyo.bluemoon.works/api/health?region=garden-1&verify=manual'
```

ブラウザ表示の変更では、必要に応じてhard reload / cache-bustを行い、古い静的assetを見ていないことも確認する。

## 6. カスタムドメイン

`wrangler.jsonc`のCustom Domain routeに `moyo.bluemoon.works` を設定しています。Static AssetsとAPIを同じオリジンで提供するため、CORSやWebSocket URLを追加変更する必要はありません。

## 7. ロールバック

Cloudflare DashboardのWorkerから過去deploymentを選び、ロールバックできます。世界状態はDurable Object SQLiteに残り、Workerコードのロールバックとは分離されています。ただし将来schema migrationを追加する場合は、後方互換性を保つ必要があります。

## 公式資料

- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/
