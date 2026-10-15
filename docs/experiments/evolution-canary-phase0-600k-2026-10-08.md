# Phase 0 evolution canary 長期追試 — 600,000 ticks (2026-10-08)

関連: CV#51 / MoYoGarden#40 / PR #51（Phase 0 実装）。
Phase 0 報告書（[evolution-canary-phase0-2026-10-07.md](./evolution-canary-phase0-2026-10-07.md)）が
「100,000 ticks は老年化18日・neutral寿命24〜32日に届かず、死亡0件で寿命が右打切り、選択効果は未判定」と
記録した点に対する追試です。**観測記録であり、`src/`・WorldState・生存/繁殖/遺伝ルール・runnerは変更していません。**

## 実行条件

| 項目 | 値 |
|---|---|
| engine commit | `4a4481764b458bd2e0f146954fa54420fc937370`（現行 main） |
| engineHash | `45d08004f37d6365447cbfbd39baef4adfe682a7b4a4e4c62950e125b1eeef0b`（Phase 0 記録と同一） |
| runner | `tools/evolution-canary.mjs`（PR #51 マージ済み、無変更） |
| Node / OS | v26.7.0 / macOS 26.6.1（10 CPU / 16 GiB） |
| ticks / sample-every | 600,000（= 69.44 人口日）/ 20,000 |
| max-runtime-ms | 3,600,000（いずれも未到達） |
| seed | 3901 / 3902 / 3903 / 3904 + 3902 再実行（5 run 並列） |
| world | 40×24 単一リージョン、初期12人、`DEFAULT_SIMULATION_CONFIG` |
| CI | 変更なし。長期runはCIに載せずローカル実行 |

**Node runtime が Phase 0 記録（v22.16.0 / Linux）と異なるため、hash は Phase 0 の記録値と直接比較しません。**
engineHash が一致しているので engine build は同一です。

## 完走結果（5 run すべて completed=true / stopReason=null / 絶滅なし）

| seed | 最終人口 | 最大世代 | 出生 | 死亡 | 死亡/人口日 | duration s |
|---:|---:|---:|---:|---:|---:|---:|
| 3901 | 18 | 2 | 13 | 7 | 0.101 | 2770.6 |
| 3902 | 16 | 4 | 29 | 25 | 0.360 | 2952.5 |
| 3902 再実行 | 16 | 4 | 29 | 25 | 0.360 | 2954.2 |
| 3903 | 17 | 4 | 31 | 26 | 0.374 | 3021.8 |
| 3904 | 17 | 4 | 25 | 20 | 0.288 | 2915.0 |

3902/3903/3904 は出生→成長→繁殖→孫世代という自然な進行で第4世代まで到達しました（繁殖や成長の強制注入はなし）。

## 実寿命（`lineage.completedLifespan`: birthTick 既知かつ run 中に死亡を観測した個体）

| seed | n | 平均(人口日) | 最小 | 最大 | 右打切り | 創始個体の死亡(unknownBirthDate) |
|---:|---:|---:|---:|---:|---:|---:|
| 3901 | 7 | 29.27 | 24.53 | 31.44 | 6 | 0 |
| 3902 | 23 | 26.13 | 19.01 | 32.24 | 6 | 2 |
| 3902 再実行 | 23 | 26.13 | 19.01 | 32.24 | 6 | 2 |
| 3903 | 22 | 26.29 | 18.01 | 32.08 | 9 | 4 |
| 3904 | 18 | 25.57 | 17.01 | 31.88 | 7 | 2 |

neutral 寿命 24〜32 人口日（207,360〜276,480 ticks）と整合し、大半は老衰由来とみられます。
最小値は 17.0〜24.5 日で、neutral 下限を下回る早期死亡も含みます。runner は死因（老衰 / 飢餓 / health）を区別しないため、
これは老衰以外の死亡が混在している可能性を示す観測であって、原因の特定ではありません。

## 形質（終了時の生存個体）

Δ は終了時平均 − 創始個体の中立値 1.0。SE は母分散 / √count による平均の標準誤差です。

| seed | vitality 平均 | 分散 | SE | \|Δ\|/SE | carryingCapacity 平均 | 分散 | SE | \|Δ\|/SE |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3901 | 0.999250 | 2.014e-05 | 0.001058 | 0.71 | 1.001717 | 5.379e-05 | 0.001729 | 0.99 |
| 3902 | 0.999281 | 2.969e-05 | 0.001362 | 0.53 | 0.997481 | 2.509e-05 | 0.001252 | 2.01 |
| 3902 再実行 | 0.999281 | 2.969e-05 | 0.001362 | 0.53 | 0.997481 | 2.509e-05 | 0.001252 | 2.01 |
| 3903 | 1.002041 | 1.229e-04 | 0.002689 | 0.76 | 1.000606 | 6.472e-05 | 0.001951 | 0.31 |
| 3904 | 0.999706 | 7.944e-05 | 0.002162 | 0.14 | 1.001365 | 3.198e-05 | 0.001371 | 1.00 |

終了時平均は 4 seed すべてで中立値 1.0 から概ね 1 SE 以内（最大は 3902 carryingCapacity の約 2.0 SE）ですが、
その方向は他の seed と逆で、seed 間で一貫した方向性選択は検出できません。
出生に伴う変異・親混合による分散は世代を通じて残っています（例: 3902 の出生時 vitality 分散 G1 1.13e-4 → G3 1.28e-4）。

## 再現性

seed 3902 と再実行は `snapshots.jsonl` が**全バイト一致**（sha256 `856500ea9ffb8ffc25dde5ad09a3a7c0a27d495f7ddca02efd22e0c510db1cf8`）。
`snapshotSeriesHash` / `finalStateHash` / `deterministicResultHash` も一致し、summary は durationMs 以外の全フィールドが一致しました。
600,000 ticks でも決定論と再現性が保たれることを確認しています。

| seed | deterministicResultHash | snapshotSeriesHash | finalStateHash |
|---:|---|---|---|
| 3901 | `1521ac04e715616785bc3ca45b1c54204995cce54598439c9c6fae40bf29e5d7` | `2e433c47d1bf4a2b4f212924f2b909297f16d91dfba3dc0fefa1b4b434d7cc31` | `19aec253b1d49d600553010069f97eb23955af78e3e9c92c7ce5514cf61fffb6` |
| 3902 | `16393fa6dd372b4bb804314ebd034025232b96eb3494c3c4381f8c813f88aaf0` | `856500ea9ffb8ffc25dde5ad09a3a7c0a27d495f7ddca02efd22e0c510db1cf8` | `ce7f067808c8a9ed73fe611742a1e837bef4b07924ca276e6610fece75044a6b` |
| 3902 再実行 | `16393fa6dd372b4bb804314ebd034025232b96eb3494c3c4381f8c813f88aaf0` | `856500ea9ffb8ffc25dde5ad09a3a7c0a27d495f7ddca02efd22e0c510db1cf8` | `ce7f067808c8a9ed73fe611742a1e837bef4b07924ca276e6610fece75044a6b` |
| 3903 | `179e382efc4ec42d87fdde41b6adabae7f3cb52b77473fc44c84195b39cb2867` | `bd79cb73899b529a9dd27aae9ac79fa0d0f3f443d412d994fc20c150a0654fb6` | `7c1e23fbf0e3a5fb9d844a7a19ffbb31e9083ad5b22d3956a475d65a473b4632` |
| 3904 | `e634eb21a1868ca6b61fe447d6510d407d444431ed7581005c93b97ad1b9ffd9` | `0aaf7debdfc7444b5aef7ad4b234e2c9f5d015cadc9f7d4cb9a58a6656dbc235` | `0a9aec35e185bf865d6c9a33a2604eeb5f00993f27f2cc8cf3aed6af9febad6b` |

resource layout hash も seed ごとに異なり、seed sensitivity を確認しています。

## 環境の観測

faction の保存 food は終盤に枯渇傾向（3902: azure 0、3903: azure/ember 0、3904: azure 0 / ember 6）でしたが、
絶滅は起こらず、tile deposit の active 数と総量は残存しています（depleted は全 run 0）。
living role 構成は forager が増加（初期 3 → 終了時 8〜11）しました。
これは観測であって、資源と出生・死亡の因果関係や食料制約の強さを断定するものではありません。

## Phase 0 の問いへの更新

| # | 問い | 100k ticks 時点 | 600k ticks 追試後 |
|---|---|---|---|
| 1 | vitality が長期生存・子孫数に影響したか | 未判定（死亡0） | **依然未判定**。死亡は観測できるようになったが、個体単位の形質→寿命/子孫数の対応は runner が集計しか出力しないため、この記録からは評価できない |
| 2 | carryingCapacity が資源取得・繁殖へ間接的に影響したか | 未判定 | 依然未判定（同上） |
| 3 | 分散は世代をまたいで残るか | G2 で非ゼロ（3個体のみ） | **残る**。4 seed すべてで G1〜G4 に非ゼロ分散を観測 |
| 4 | 資源密度で有利な形質が変わるか | 未判定 | 依然未判定（統制比較なし） |
| 5 | lineage は単一系統へ急速に偏るか | 集中なし（0.107〜0.125） | 集中なし。終了時 top founder 期待祖先寄与 0.111〜0.162 |
| 6 | 既存系だけで環境→選択圧 feedback を観測できるか | 未了 | 未了（個体単位の相関が必要） |

top founder 期待祖先寄与:

| seed | 600k 終了時 | （参考）Phase 0 100k |
|---:|---:|---:|
| 3901 | 0.1111 | 0.1071 |
| 3902 | 0.1484 | 0.1125 |
| 3903 | 0.1544 | 0.1250 |
| 3904 | 0.1618 | — |

## Phase 1 判断（維持）

**新 strategy trait は引き続き導入しません。** 600,000 ticks（69.4 人口日 / 最大4世代）まで延長しても、
`vitality` / `carryingCapacity` の終了時平均は中立値から一貫した方向へは動かず、seed 間で方向が一致しません。
分散は世代をまたいで維持されています。これは「選択圧が無い」ことの証明ではなく、
**現行の観測出力では個体単位の選択効果と mutation / drift / founder 効果を分離できない**ことを示します。

次工程（この記録では実装しない）:

1. runner に **opt-in の per-agent 出力**（agentId / parents / birthTick / deathTick / 出生時形質 / 子数）を追加し、
   既存の集計ベース・決定論・隔離契約を変えない。schema と contract test を伴う。
2. その出力で lineage-born cohort の実寿命・子孫数を形質別に評価し、世代・年齢・role・環境を統制して選択効果を分離する。
3. 結果が揃うまで Phase 1 の形質追加は判断しない。

## 限界

- 集計ベースのため、個体単位の trait→寿命/子孫数の相関は未評価。
- Node v26.7.0 / macOS の実行。Phase 0 記録（v22.16.0 / Linux）とは hash を直接比較しない。
- 単一リージョン・handoffなし・創始個体は老衰しない既存互換仕様のまま。
- `topFounderConcentration` は期待祖先寄与であり、遺伝的因果効果の推定値ではない。
- runner は死因を区別しない。
- 寿命の一部は右打切り（birthTick 既知で終了時生存）。

## 再実行

```bash
git checkout 4a4481764b458bd2e0f146954fa54420fc937370
npm ci && npm run build:ts
node tools/evolution-canary.mjs --seed 3902 --ticks 600000 --sample-every 20000 \
  --max-runtime-ms 3600000 --output /tmp/moyo-evolution-3902-600k
```

出力先は新規ディレクトリを指定します。正常完走は exit 0、時間上限での中断は exit 2、その他は exit 1 です。

生データ（5 run の `snapshots.jsonl` / `summary.json` / 実行ログ）は別途成果物として保存しています。
