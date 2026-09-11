# MoYoGarden repository rules

このファイルは、MoYoGarden を変更する人間・自動化エージェント共通の運用ルールです。特に `main` / 本番版へ反映する変更では、以下を完了条件として扱います。

## 本番反映の必須手順

1. **着手時に最新 `main` を取り直す。**
   - 作業開始時のHEADを記録する。
   - 六角リージョン、streaming、handoff、halo、world simulationに関係する変更では Issue #3 を読み、完了済み/未完了項目と直近変更を確認する。
   - open Issueも確認し、既存TODOとの重複を避ける。

2. **1回の変更は小さく閉じる。**
   - 既存40x24 WorldState、Durable Object、tick、BOT API、本番永続stateを一括破壊しない。
   - 原因に対応した最小差分を優先し、可能なら回帰テストを追加する。
   - 見た目の不具合は、静的コードだけでなく、runtime override・別renderer・LOD・再同期・handoff後の再生成経路も確認する。

3. **`main` へ反映しただけで完了扱いにしない。**
   最終commitについて、最低限すべて確認する。
   - GitHub Actions `Validate build` が success
   - Cloudflare `Workers Builds: moyo-garden` が success
   - `https://moyo.bluemoon.works/api/meta` の `build.commit` が **最終main SHAと完全一致**
   - `https://moyo.bluemoon.works/api/health?region=garden-1` が成功

4. **クライアント/描画変更は実表示確認までが完了条件。**
   - CI、Workers Builds、`/api/meta`、healthが成功しても、画面上の見た目が正しい保証にはならない。
   - rendering / UX / LOD / model / streaming表示を変更した場合は、本番ブラウザまたは本番配信assetで変更が実際に反映されていることを確認する。
   - 実表示を確認できない環境では「本番deploy済み・実表示確認待ち」と報告し、**「修正完了」「直った」と断定しない**。
   - ユーザーの実スクリーンショット/観測が静的コードの想定と食い違う場合は、実観測を優先して再調査する。

5. **完了報告には証跡を残す。**
   - 最終main SHA
   - GitHub Actions結果
   - Cloudflare Build ID / Version ID（取得できる場合）
   - production commit / health確認結果
   - Issue #3に関係する変更なら、その内容と残作業をIssue #3へ追記する。

## 周辺リージョン描画の不変条件

- 通常プレイで、注目リージョン外のBOTを**点だけのmarker**へ退化させない。
- 周辺BOTは最低でも人型と認識できるsilhouetteを持つこと。point-only表示はdebug用途に限定する。
- 軽量化する場合も、注目リージョンと周辺リージョンが別ゲームに見えるほど色・形・質感を乖離させない。
- 周辺表示の性能最適化は、high/medium authored modelやAnimationMixerを省く方向を優先し、視認性そのものを削らない。
- live window再同期、model refresh、quality runtime override、camera handoff後にも同じ最低視認性を維持する回帰テストを置く。

## Cloudflare本番対象

- Worker: `moyo-garden`
- Production branch: `main`
- Custom domain: `moyo.bluemoon.works`
- Production verification region: `garden-1`

詳細なCloudflare設定は `docs/CLOUDFLARE_DEPLOY.md`、一般検証は `docs/VERIFICATION.md` を参照する。
