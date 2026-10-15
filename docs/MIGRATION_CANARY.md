# 周期移住の比較canary

Phase 0 (#40 / #51) の既存観測を再利用する、**ローカル限定の実験runner**。
本番BOTの移住方策を切り替えるPRではない。既存の生存・受胎・出生・成長・死亡・
`vitality` / `carryingCapacity` の継承を変更せず、移住の時間配置を比較する。

## 研究から取り入れた部分

Masoumi, Kaveh, Ejtehadi, *Effects of Periodic Migration on Selection in Subdivided Populations*
(arXiv, 2026-10-06): https://arxiv.org/abs/2610.08160

同じ平均移住量でも、周期・位相・方向非対称性を区別すべき、という実験設計を採用した。
本論文の二生息地Moranモデルや選択係数を再実装したものではなく、論文結果の再現や
MoYoGardenでの自然選択の実証を主張しない。協力学習・群知覚・病原体の新形質・
ニューラル方策はこのPRに混ぜず、別の実験として扱う。

## 実行

Node.js 22以降。既存の依存を `npm ci` で用意して実行する。

```sh
# 軽量な配線確認。生物学的な進化を評価する長さではない。
npm run experiment:migration -- --seed 3902 --mode all \
  --period 32 --ticks 32 --max-travel-ticks 16 --sample-every 16 \
  --max-runtime-ms 30000 --commit "$(git rev-parse HEAD)" \
  --output artifacts/migration-smoke-3902

# より長い実験用の設定例。完走/実現移住数を必ず検査する。
npm run experiment:migration -- --seed 3902 --mode all \
  --period 8640 --ticks 259200 --sample-every 8640 \
  --max-runtime-ms 120000 --commit "$(git rev-parse HEAD)" \
  --output artifacts/migration-long-3902
```

`--mode` 省略時は5条件を順番に実行する。個別条件も指定可能。
`--max-runtime-ms` は **1条件ごと**の時間上限で、未完了条件が出たら後続条件を開始しない。
上限はtick間の協調的チェックであり、実行中の単一tickを強制停止するwatchdogではない。
中断時は途中までのJSONLと `completed=false / stopReason=max-runtime-ms` のsummaryを保存し、exit 2。
不正引数・I/Oエラーはexit 1。exit 0も「比較成立」「進化を検出」を意味しない。
外部killでsummaryが作られなかったディレクトリは未完了として扱う。

出力先は新しいローカルディレクトリだけ。既存出力の上書き、URL、UNC、symlink、
`.wrangler` 等の予約領域は既存Phase 0 guardで拒否する。認証・ネットワーク・Worker接続は不要。

## 比較条件

| mode | 時間配置 | 1周期の方向別予定数（既定4件） |
|---|---|---|
| `constant` | 周期全体へ等間隔 | A→B: 2 / B→A: 2 |
| `in-phase` | 両方向とも最初の1/4周期 | 2 / 2 |
| `out-of-phase` | A→Bは最初の1/4、B→Aは半周期後 | 2 / 2 |
| `constant-asymmetric` | 周期全体へ等間隔 | 3 / 1 |
| `out-of-phase-asymmetric` | 方向間で半周期の位相差 | 3 / 1 |

方向偏りと周期性を混同しないよう、上3条件と下2条件を別々に比較する。
`period` と `migrants` は4の倍数、`migrants <= period / 4`。
予定人数は整数積算で各周期・各方向の予算と厳密一致する。`ticks` は周期の整数倍。
予定時刻は各間隔の中央に置き、最後の予定移動も収束できるよう、全条件に同じ
`maxTravelTicks + 1` ticksの追加観測期間を設ける。これはCLIの `ticks` には含まれず、
summaryの `requestedWorldTicks` / `completedTicks` に含まれる。

## 移動と実験境界

- 2つの40×24 storage / active hexの `WorldRuntime` を同じ論理tickで進める。
  各条件の初期状態は同じ。Aのseedは指定値、Bはseedから決定論的に導出する。
  **既存generatorで独立生成した2生息地**であり、本番frontierの連続気候・水系・haloの再現ではない。
- 移住予定時刻に、到達可能な境界を持つ自律成人を選ぶ。妊娠中、扶養中、外部task中の個体は除く。
  選択の順位はseed・方向・予定番号・canonical IDで固定し、条件ごとに異なる時刻を乱数seedにしない。
- 既存Command parserと決定論的pending queueへ `move` を入れ、境界までは通常の移動コストを払う。
  `submit()` の壁時計/UUID生成は使わない。到達性BFSは実験操作側の完全snapshotに基づくため、
  **これは自然発生的な移住方策や局所知覚BOTの性能評価ではない**。
- 既存 `regionCellTransition` が解決するexact seamだけを越える。source-local座標をtargetへ流用しない。
  到着時に `detachAgentOwnership` / `attachAgentOwnership` を使い、両方成功時だけ状態を採用する。
  ターゲットが通行不能ならsourceから消さない。所持品・形質・家族参照は既存helperが運ぶ。
- 1方向あたり同時移動1件、移動期限は既定64 ticks。未着手/時間切れ/死亡/移管失敗を分けて記録し、
  不足人数を追加spawnやコピーで埋めない。外部move中のneeds制約も既存engineのまま。
- `src/`、WorldState/schemaVersion、所有権journal、production storage、deploy設定は変更しない。
  これはローカルの原子的状態操作であり、分散handoffのcrash/retry保証を検証するものではない。

## 観測と解釈

各条件の出力:

- `snapshots.jsonl`: 全体/地域別人口、出生・死亡、形質分布、資源、地域別流入/流出、移住集計。
- `migration.jsonl`: 予定時刻・開始/未着手・到着/失敗、canonical個体ID、移動日数ではなく移動tick数。
- `summary.json`: 初期/最終形質、地域別最終snapshot、系譜、方向別予定/開始/到着/未着手/失敗/移動中。
  engine hash、実験コードhash、初期state hash、最終state/保留command hash、両JSONLのSHA-256、結果hashを含む。
- 親ディレクトリの `comparison.json`: 上3条件/下2条件それぞれの **実現移住数がそろったか**。

各地域の `initial + births - deaths + arrivals - departures == living` を検証する。
観測側だけでglobal IDへ正規化し、同名のlocal founderを混同しない。
移住後にIDが昇格しても出生/死亡に数えず、子孫は元地域の親へ接続する。
遺伝的多様性の代理として既存の**連続2形質の分散**を記録する。allele頻度やheterozygosityではない。

比較成立は全条件完走・同一初期状態/設定/コード・各方向で全予定移住を実現した場合に限る。
到着0、欠けた条件、途中打切り、未達を含む比較は `countMatched=false`。
予定数が一致しただけで「平均移住量を統制できた」と言わない。
移動完了時刻と予定時刻は違うため、到着遅延も `migration.jsonl` で確認する。

人口密度・食料・移動による機会費用・系譜構成は結果と一緒に変わり得る。
`countMatched=true` でも選択効果の検出や因果の分離を意味しない。
出生を伴わないsmokeや、創始個体の中立形質だけでは方向性選択を評価できない。
長期化する場合も、Phase 0と同じく創始個体/出生個体、未知寿命/右打切りを分ける。
同じコード・Node環境・seed・設定で再実行し、複数seedを比較してから生物学的解釈へ進む。

## 検証記録（2026-10-09）

開始main: `4a4481764b458bd2e0f146954fa54420fc937370`。
ローカルcloneはDNS解決不可だったため、成功済みCI run `37591870077` のoffline bundleを使用。
bundle commit `d40c82ccecb94b7a73556e44abca19af2156979f` から開始mainまでの差分は
`tests/virtual-catchup-do.test.mjs` のみで、今回使うengine/toolsは一致することをGitHub compareで確認した。

- 新規 `tests/migration-canary.test.mjs`: 12/12 pass。
- 既存 `evolution-canary-contract` / `agent-ownership*` / `family-handoff-lineage`: 26/26 pass（新規と合計38件）。
- 同一seedの実engine replay、サンプリング間隔変更時の最終state/移住event hash一致、
  local→global ID昇格、物資/形質保存、到着先閉塞の原子性、親子関係、strict引数、CLI出力/部分結果を検証。
- `npm run check`: pass（ローカルTypeScript 5.8.3、Node 22.16.0。repo指定compilerは5.9.3のためCIでも再検証する）。
- 追加の256周期/256予定ticks・seed 3902では `constant` と `in-phase` がそれぞれ289世界ticksまで完走し、
  両方向とも予定2件/到着2件、失敗/未着手0を確認。`out-of-phase` を含む全5条件の追加実行は
  この実行環境の時間制限内に完了しておらず、条件間の比較成立を主張しない。
- 3seedの全5条件追加実行も時間制限で未完了。長期進化、自然な出生を含む実験評価、本番実表示は未確認。
- 全体build/testはPRのCIで確認する。ローカルoffline bundleはブラウザassetを含まない。
