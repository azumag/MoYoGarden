# IMPLEMENT-57.md — PR #57 依存関係更新の実施記録

## 概要

PR #57「chore(cf): verify cf CLI migration parity in a branch (#46)」の CI「Validate build」失敗（`npm audit --audit-level=high` で high 9件）を、opencode の判断 (b) 依存関係の更新で解消する。

- 開始 HEAD: `aee88cb`（PR head）／現行 main `6bf2996`（ブランチは既に現行 main を base にしていたため rebase は不要だった）
- 作業ブランチ: `impl/57-dep-update`（PR ブランチ `cf/cli-migration-verify-20261009` へ push）

## 実施内容

- `package.json`
  - `cf`: `1.0.0-beta.13` → `1.0.0-rc.4`（明示 pin）
  - `wrangler`: `4.148.0` → `4.167.0`
  - `overrides.undici`: `7.30.2` を追加
  - `npm install` で lockfile を再生成（`npm audit fix --force` は使っていない）
- `docs/CF_MIGRATION_PARITY.md`: 検証環境のバージョン記載を更新（cf 1.0.0-rc.4、wrangler 4.167.0、undici 7.30.2）

## 実測結果

| 検証 | 結果 |
|---|---|
| `npm install` | 成功（lockfile 再生成） |
| lockfile の解決バージョン | undici 7.30.2、sharp 0.35.5、zod 4.6.6、wrangler 4.167.0、cf 1.0.0-rc.4 |
| `npm audit --audit-level=high` | この VM では実行不可。egress ポリシーで監査エンドポイント（`POST /-/npm/v1/security/audits/quick`）が遮断されるため。CI の Validate build で実測する |
| `npm run check`（tsc --noEmit） | exit 0 |
| `npm test` | 1047 pass / 0 fail |
| `npx cf deploy --dry-run`（production） | 成功（`--dry-run: exiting now`、assets 102 files / 626.21 KiB、API 呼び出しなし） |
| `npx cf deploy --mode pbr-preview --dry-run` | 成功（同 102 files / 219.25 KiB） |

## レシピからの乖離（重要）

opencode の確定レシピは wrangler 4.151.3（現行 main の版）だったが、cf 1.0.0-rc.4 の local runtime は「wrangler@4.163.0 or newer」を要求し、4.151.3 では `cf deploy --dry-run` が失敗した。そのため wrangler を最新 4.167.0 へ上げて解決した。

wrangler は production deploy 経路（Workers Builds の `npx wrangler deploy`）でも使われるため、この更新の採用可否は opencode の判断に委ねる。

## 残件

- CI の Validate build（`npm audit --audit-level=high` で high 0）の確認
- opencode による wrangler 4.167.0 採用の判断
- マージ判断は MoYoGarden の運用ルールに従う（本 PR のマージはここでは行わない）
