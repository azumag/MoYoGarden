# cf CLI 移行の parity 検証（Issue #46）

このドキュメントは Issue #46「MoYoGarden の Cloudflare 運用を cf CLI / cloudflare.config.ts へ移行する」のうち、**検証ブランチでの `cf migrate` 実行と parity 確認**の結果をまとめたものです。

**production 経路は置換していません。** `wrangler.jsonc` / `wrangler.pbr.jsonc` / `npx wrangler deploy` / 現在の Workers Builds 設定はそのまま残しており、本ブランチは `cf` 側で同等性が取れるかを実測したものです。

## 検証環境

```text
branch        cf/cli-migration-verify-20261009（main 4a44817 から分岐）
cf            1.0.0-beta.12（検証用のグローバル install）
project cf    1.0.0-beta.13（devDependency として追加）
wrangler      4.148.0（cf の Wrangler bundler は 4.136.0 以上が必要）
Node.js       24.18.0（cf は Node.js 22 以降が必要）
```

## 生成・変更したファイル

| ファイル | 変更 |
|---|---|
| `cloudflare.config.ts` | `cf migrate` が生成。`TODO(@cloudflare)` と `throw` をすべて解消し、production と PBR preview を 1 ファイルに統合 |
| `wrangler.config.ts` | `cf migrate` が生成。cf の Wrangler bundler が読む build 設定（custom build hook / source map / assets ディレクトリ / 型生成の無効化） |
| `package.json` / `package-lock.json` | `cf` を devDependency に追加、`wrangler` を 4.148.0 へ更新 |
| `.gitignore` | `.cloudflare/`（cf の Build Output / 生成型）を追加 |
| `tests/cloudflare-build-dedup.test.mjs` | `wrangler.config.ts` が同じ custom build hook を保つ回帰テストを追加 |
| `wrangler.jsonc` / `wrangler.pbr.jsonc` | **未変更**（検証中は fallback として維持） |

`cf migrate` の `--no-install` で構成ファイルだけを生成した後、`cf` を devDependency として追加しています（`cloudflare.config.ts` が `cf/config` を import するため、プロジェクト自身の依存が必要）。

## production: `wrangler.jsonc` → `cloudflare.config.ts` の parity

| wrangler.jsonc | cloudflare.config.ts / wrangler.config.ts | 判定 |
|---|---|---|
| `name: moyo-garden` | `worker.name` | 一致 |
| `main: src/arrival-registration-reliability-entry.ts` | `worker.entrypoint` | 一致 |
| `compatibility_date: 2026-08-28` | `worker.compatibilityDate` | 一致 |
| `upload_source_maps: true` | `wrangler.config.ts` の `uploadSourceMaps` | 一致（Build Output に `*.js.map` を確認） |
| `build.command: node scripts/wrangler-build.mjs` | `wrangler.config.ts` の `build.command` | 一致（build ログで hook 実行を確認） |
| `assets.directory: ./public` | `wrangler.config.ts` の `assetsDirectory` | 一致（102 ファイルの asset 読込を確認） |
| `assets.binding: ASSETS` | `worker.env.ASSETS = bindings.assets()` | 一致 |
| `assets.not_found_handling: single-page-application` | `worker.assets.notFoundHandling` | 一致 |
| `assets.run_worker_first: ["/api/*"]` | `worker.assets.runWorkerFirst` | 一致 |
| `routes: [{ pattern: moyo.bluemoon.works, custom_domain: true }]` | `worker.domains: ["moyo.bluemoon.works"]` | 一致 |
| `durable_objects.bindings: REGIONS / RegionDurableObject` | `worker.env.REGIONS = bindings.durableObject({ worker, exportName })` | 一致（命名の手動レビュー済み） |
| `migrations: [{ tag: v1, new_sqlite_classes: [RegionDurableObject] }]` | `worker.exports.RegionDurableObject = exports.durableObject({ storage: "sqlite" })` | 一致（手動変換） |
| `vars.*`（5 件） | `worker.env.* = bindings.text(...)` | 一致 |
| `observability: { enabled, head_sampling_rate: 0.1 }` | `worker.observability` | 一致 |

`migrations` は `cf migrate` が変換しない required item です。Wrangler 側は `new_sqlite_classes` でクラスを作成しているため、`cf` の exports ライフサイクル宣言では `storage: "sqlite"` を指定しています。**初回の `migrations` → `exports` 切替デプロイでは、現在 live な namespace をすべて宣言する必要があります**（本ブランチは `RegionDurableObject` の 1 件のみで、Wrangler 側と同一）。

## PBR preview: `wrangler.pbr.jsonc` の隔離の再現

`cf` は `env` ブロック + `--env` ではなく **mode** で構成を切り替え、戻り値の `worker.name` が変わったときだけ別 Worker をデプロイします。そのため `wrangler.pbr.jsonc` の隔離は `--mode pbr-preview` で再現しました。

| wrangler.pbr.jsonc | `--mode pbr-preview` の戻り値 | 判定 |
|---|---|---|
| `name: moyo-garden-pbr-preview` | `worker.name` | 一致 |
| `main: src/worker.ts` | `worker.entrypoint` | 一致 |
| `workers_dev: true` | `worker.workersDev` | 一致 |
| `preview_urls: false` | `worker.previewUrls` | 一致 |
| routes なし | `domains` なし | 一致 |
| `vars.REGION_IDS: garden-1`（のみ） | `env.REGION_IDS` | 一致 |
| `durable_objects` / `migrations` | 同一の `bindings.durableObject` / `exports.durableObject` | 一致 |

production と preview は別 Worker 名・別 entrypoint のまま維持され、`REGION_IDS` も preview のみ `garden-1` のままです。

## 実行した検証と結果

すべて Node.js 24.18.0 / 検証ブランチで実行しました。

```text
cf workers types [--mode pbr-preview] --no-include-runtime
  → 成功。cf が cloudflare.config.ts を評価し .cloudflare/types/index.d.ts を生成
    （Cloudflare.Env / durableNamespaces を exports 宣言から推論）

npx tsc --noEmit --strict --exactOptionalPropertyTypes --moduleResolution Bundler cloudflare.config.ts
  → エラー 0

cf deploy --dry-run              （production / mode なし）
  → 成功。custom build hook 実行、テスト 861/861 pass、
    assets 102 ファイル、DO は "defined in moyo-garden"、
    REGION_IDS = garden-1,garden-2,garden-3、domains = moyo.bluemoon.works

cf deploy --mode pbr-preview --dry-run
  → 成功。Worker 名 moyo-garden-pbr-preview、entrypoint worker.js、
    workersDev true / previewUrls false、REGION_IDS = garden-1
```

`cf deploy --dry-run` は API を呼ばず credential も不要なため、production へ何も送信していません。Build Output（`.cloudflare/output/v0/workers/default/worker.config.json`）で上表の各フィールドを突き合わせ済みです。

補足: macOS の既定 `TMPDIR`（`/var/folders/...`）は `/var` が symlink のため、`tests/evolution-canary-contract.test.mjs` の 1 件が環境起因で失敗します（本変更とは無関係。symlink を含まない `TMPDIR` では 861/861 pass）。CI（ubuntu-latest）では発生しません。

## 残る Wrangler fallback と撤去条件

| 箇所 | 理由 | 撤去条件 |
|---|---|---|
| `wrangler.jsonc` / `wrangler.pbr.jsonc` | cf 側の parity は確認したが、Workers Builds の Build/Deploy command と本番 deploy 経路が未切替 | Workers Builds を cf 前提へ切替え、`deploy` で実 deploy を 1 回検証した後 |
| `npx wrangler deploy`（Workers Builds Deploy command） | 同上 | 同上 |
| `wrangler tail` / `wrangler secret put` | cf 未対応（公式に `npx wrangler` を案内） | cf が対応した時点 |

cf が beta のため、`@cloudflare/config` と `wrangler.config.ts` のフィールドは変更される可能性があります。

## production 経路への影響（要判断）

parity 検証のため **`wrangler` を 4.127.1 → 4.148.0 に更新**しています。cf の Wrangler bundler は 4.136.0 以上を要求するため必須です。

ただし `wrangler` は現在の本番 deploy（Workers Builds の Deploy command `npx wrangler deploy`）でも使われるため、この更新は**本番 deploy 経路に触れる唯一の変更**です。`deploy` へ反映する前に、Workers Builds で新 wrangler の deploy を 1 回検証するか、`cf` 切替と同じタイミングでまとめて反映する判断が必要です。

## 次工程（Issue #46 の残 TODO）

1. 本ブランチの実 deploy 検証（`cf deploy` または `cf previews deploy`）を承認後に実施
2. Workers Builds の Build/Deploy command を `cf` 前提へ更新できるか確認（`npm run check` → `cf build` / `cf deploy`）
3. `cf dev` / `cf deploy --mode pbr-preview` を `package.json` の script へ反映し、Observability / logs / resource inspection の cf 運用を整理
4. AI/開発者向けドキュメントへ cf-first ルールを追記
5. parity 確認後に `wrangler*.jsonc` と wrangler fallback を削除（理由と条件は上表）

## 公式資料

- https://developers.cloudflare.com/cf/wrangler/migrate/
- https://developers.cloudflare.com/cf/wrangler/reference/
- https://developers.cloudflare.com/cf/projects/
- https://blog.cloudflare.com/cloudflare-cf-cli-launch/
