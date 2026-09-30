# Cloudflare Workers Buildsによる本番反映

`main`は開発正本、`deploy`は本番反映用ブランチです。Cloudflare Workers Buildsは`deploy`への対象変更を検知して`moyo-garden`を本番へデプロイします。GitHub ActionsはPR/main/deployのbuild/testを行い、`deploy`へのpush時だけ本番commitも確認します。

**mainのCI成功、Cloudflareのbuild成功、GitHub Actionsのbuild成功を、それぞれ単独で本番反映完了とみなさないでください。** 完了条件は`AGENTS.md`の「本番反映の必須手順」を正本とします。productionは対象`deploy` SHAと比較し、未リリースの最新main SHAとは比較しません。

定期実行は読み取り・レビュー・Issue更新・作業ブランチとPRまでです。merge、`deploy`更新、production deploy、Cloudflare設定変更、Secret操作は行いません。以下の接続・設定・リリース手順は、別途明示承認された実行だけを対象とします。

### cf-first 移行中の操作面

Cloudflare 操作は Issue #46 を正本として、今後は `cf` CLI / `cloudflare.config.ts` を優先して移行します。ただし、**現在の production 経路は parity 確認が完了するまで `wrangler.jsonc` / `npx wrangler deploy` を維持**します。

特に Durable Object bindings / migrations、`moyo-garden-pbr-preview` の isolation、custom build hook、Workers Builds の build/deploy 契約は、`cf` 側で同等性を確認する前に置換しません。残る Wrangler 利用は移行期間中の明示的 fallback とし、理由と撤去条件は Issue #46 で管理します。

## 1. GitHubリポジトリを接続

新規接続時はCloudflare Dashboardの**Workers & Pages**からGit連携を設定し、`azumag/MoYoGarden`を選びます。既存接続を再作成する必要はありません。

CloudflareアカウントへのGitHub App認可は、一度だけ必要な管理操作です。定期タスクは接続・権限を変更しません。

## 2. Build設定と確認済み実行値

2026-09-27 UTCの本番Build `0af8085e-5855-48dc-bb3f-a9bc8f887adc`は、`deploy`の`a7bf9a1d25ac08d567922fb27d78fe5d1446794d`について次のコマンドで成功しています。

```text
Worker name:       moyo-garden
Production branch: deploy
Root directory:    /
Build command:     npm run check
Deploy command:    npx wrangler deploy
```

実行コマンドはWorkers BuildsのBuild詳細で確認します。Worker名とcustom build hookは`wrangler.jsonc`、各npm scriptは`package.json`を参照してください。文書を直しただけでCloudflare設定が変更されるわけではありません。

### Build Minutesのコスト制御

不要なfeature branch buildを避ける運用上の設定は次のとおりです。Dashboardの現状値を確認できない実行では、これらを確認済みと報告しないでください。

```text
Production branch:                  deploy
Builds for non-production branches: OFF
Build cache:                        ON
```

Build watch pathsでは、deploy artifactを変えない次の変更を除外する方針です。

```text
.github/*
docs/*
tests/*
AGENTS.md
README.md
```

`src/`、`scripts/`、`public/`、`package*.json`、`wrangler*.jsonc`、TypeScript設定はdeploy内容またはbuild生成物へ影響するため除外しません。除外対象外のファイルが同じpushに含まれれば、通常のbuild対象になります。watch paths、cache、branch controlの変更は自動で行わず、現状確認と提案に留めます。

### custom build hookと重複build防止

確認済みの本番経路は次の順序です。

1. Dashboardの`npm run check`でTypeScript型検査を行う。
2. `npx wrangler deploy`が`wrangler.jsonc`の`node scripts/wrangler-build.mjs`を呼ぶ。
3. 同一Workers Build commitの有効なmarkerがなければ、hookが`npm run build:web`を実行する。
4. `build:web`はbuild metadata、テスト、モデル生成、Three.js/各資産配置、ブラウザ構文・資産検査を行い、完了時にmarkerを記録する。

`npm run check`だけでは資産を生成しません。以前のようにDashboardで`npm run build`を実行した場合や、同一Workers Build commitで既に資産を生成済みの場合は、markerによってhook側の二重`build:web`を省けます。markerが無い、commitが違う、Workers Builds外の場合は再buildするfail-safe設計です。

この重複防止はbranch controlの代替ではありません。feature branch buildそのものの抑制はnon-production branch builds設定で行います。

## 3. Runtime Secretsと通常設定

承認済みの初期設定で、異なる十分に長い値をRuntime Secretとして設定します。

```text
COMMAND_TOKEN = BOT・人間の通常コマンド用
ADMIN_TOKEN   = pause/reset/manual tick等の管理用
```

Build variableと混同しないでください。定期実行でSecretを作成・取得・変更したり、値を出力したりしません。

通常設定は`wrangler.jsonc`にあります。

```text
DEFAULT_REGION_ID = garden-1
REGION_IDS         = garden-1,garden-2,garden-3
WORLD_SEED         = 424242
TICK_MS            = 10000
OPEN_COMMANDS      = false
```

`REGION_IDS`は段階移行中のlegacy互換設定です。canonical axial regionを含む連続世界の現行仕様はIssue #3 / #27と現在実装を確認してください。`OPEN_COMMANDS=true`は公開実験向けで、通常運用ではfalseのままにします。

## 4. PR/mainとdeployの実行経路

### PR / main

`.github/workflows/ci.yml`の`Validate build`がdependency installと`npm run build`を実行します。TypeScript、テスト、ブラウザJavaScript、authored/PBR/Quaternius資産の検査を含みます。

`Verify production commit`はskipされます。これは意図した動作であり、PR/mainの検証のためにproduction deployを起動する必要はありません。

### deploy push

承認済みの`deploy`更新後は、対象変更に対するCloudflare Workers BuildsとGitHub Actionsを別々に確認します。

Cloudflare側は上記の`npm run check` → `npx wrangler deploy` → custom build hookを実行します。GitHub側は`Validate build`の後に、`Verify production commit`がcache-bust付きで`/api/meta`をpollします。`build.commit`がそのdeploy workflowのSHAと一致した後、`garden-1`のhealthを確認します。

watch paths等でCloudflare buildが起動しなかった場合も、GitHub CIの成功だけからproductionの更新を推測しないでください。対象commitのBuild有無とproduction commitを確認します。

## 5. 本番反映の完了条件

本番へ反映する**対象deploy commit**について、次のすべてを確認します。

1. `Validate build` = success
2. 対象commitのWorkers Builds = success
3. `Verify production commit` = success、かつ`/api/meta`の`build.commit` = 対象deploy SHA
4. `/api/health?region=garden-1` = success
5. 描画/UX/LOD/model/streaming変更では、本番実表示または本番配信assetでも変更を確認

5を確認できない場合は「deploy済み・実表示確認待ち」とし、「直った」「修正完了」と断定しません。報告にはmain/deploy SHA、GitHub run、Cloudflare Build ID / Version ID（取得できる場合）、production commit、health、Observabilityの確認時刻と範囲を残します。観測データ不足とエラー0件を混同しないでください。

承認済みリリース後の読み取り確認例:

```bash
curl -H 'cache-control: no-cache' \
  'https://moyo.bluemoon.works/api/meta?verify=manual'

curl -H 'cache-control: no-cache' \
  'https://moyo.bluemoon.works/api/health?region=garden-1&verify=manual'
```

ブラウザ表示の変更では、必要に応じてhard reload/cache-bustを行い、古い静的assetを見ていないことも確認します。

`deploy`が24時間以上更新されずmainより遅れている場合、定期実行では両SHA、CI、Workers Builds、Observabilityを読み取り確認します。条件が揃えば「手動deploy可能」と報告するだけにし、自動追従・merge・deployは行いません。未確認・失敗があればその条件も明記します。

## 6. カスタムドメイン

`wrangler.jsonc`のCustom Domain routeは`moyo.bluemoon.works`です。Static AssetsとAPIを同じオリジンで提供します。既存route、binding、CORS、WebSocket設定を文書更新に伴って変更しません。

## 7. ロールバック

承認済みの本番対応ではCloudflare Dashboardから過去deploymentへのロールバックを検討できます。Durable Object SQLiteの世界状態はWorkerコードのロールバックとは別なので、コードを戻してもstateまで戻るとはみなしません。schema互換性と進行中handoff等への影響を確認し、定期実行ではロールバックも行いません。

## 公式資料

- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/
