# Phase 0 evolution canary — 2026-10-07

関連: #40 / PR #51。**観測基盤と初回3-seed実験を受け入れる。Phase 1の新strategy traitは現時点では導入しない。**
これは選択圧が存在しないという判定ではない。死亡・寿命と形質の因果効果は、この実験期間では未評価である。

## 実行条件と出典

- engine source: `bb1a84271c449048eef560eeeb68df02827b8f32`（現行mainの既存WorldRuntime、ルール変更なし）
- runner / isolation実装: `9df2e0a24656d8f1ba4a6c798dfef2127e2098af`
- schema / contract tests / documentation: `24c19623a04f99d312e56097cde5568e65a80383`
- 上記2commitのrunnerとisolationは同一。CI artifactの8 engine moduleも同一バイト列であることを照合した。
- Node v22.16.0 / Linux、独立4プロセスで3 seed＋seed3902の再実行。長期runはCIではなくローカル実行。
- 各100,000 ticks、sample every 8,640 ticks、runtime safety limit 1,200,000 ms。
- world 40×24、単一リージョン、初期12人、DEFAULT_SIMULATION_CONFIGをそのまま使用。
- 開始: 2026-10-07 16:46 JST。4 runすべて完走し、17:03 JSTに完了状態を確認した。
- engineHash: `45d08004f37d6365447cbfbd39baef4adfe682a7b4a4e4c62950e125b1eeef0b`
- 各runにtick 0と最終tickを含む13 snapshot、summary JSONを保存。全52 snapshotと4 summaryが独立したJSON Schema Draft 2020-12検証を通過。

## 完走結果

| seed | ticks | final population | births | deaths | max generation | duration ms | top founder ancestry share |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 3901 | 100000 | 14 | 2 | 0 | 1 | 915177.484 | 0.107142857143 |
| 3902 | 100000 | 20 | 8 | 0 | 2 | 937365.388 | 0.1125 |
| 3903 | 100000 | 18 | 6 | 0 | 2 | 960660.275 | 0.125 |
| 3902 repeat | 100000 | 20 | 8 | 0 | 2 | 940456.545 | 0.1125 |

全runで `completed=true`、`stopReason=null`、絶滅なし。全snapshotで人口収支 `12 + births - deaths = living`、年齢段階件数の合計、形質範囲0.9〜1.1を検証した。
時間は4プロセス並列時の各プロセスのwall-clock実測であり、将来の単独実行時間の保証や単純な線形外挿には使わない。

創始個体をG0とし、子は `max(parent generation)+1`。3901はG1が2人、3902はG1が5人・G2が3人、3903はG1が5人・G2が1人。
3902/3903では自然な出生→成長→繁殖→孫世代への遺伝まで到達した。runnerから繁殖や成長を強制していない。

## 形質と環境

| seed | living vitality mean | vitality variance | living carryingCapacity mean | carryingCapacity variance | final stored food total | final food deposit amount |
|---:|---:|---:|---:|---:|---:|---:|
| 3901 | 0.999150000000 | 0.000023063929 | 0.998050000000 | 0.000025395357 | 1160 | 1783 |
| 3902 | 1.000210000000 | 0.000064469900 | 0.995480000000 | 0.000063887600 | 909 | 1849 |
| 3903 | 0.996266666667 | 0.000068611111 | 1.001661111111 | 0.000026967932 | 1145 | 1746 |

初期形質は全創始個体で両方1.0、分散0。出生に伴いbounded mutationと親混合による分散が生じた。
3902のvitality出生時分散はG1で0.0001936384、G2で0.000068862222。carryingCapacityはG1で0.000087324、G2で0.000068562222。
3903のG2は1個体だけなので、その世代内分散0を形質多様性の消失と解釈してはいけない。

終了時の最大founder期待寄与率は10.71〜12.5%。この期間に単一founderへの極端な集中は観測していない。
この比率は両親から1/2ずつ引き継ぐ期待祖先寄与であり、重複するdescendant数を単純加算した比率ではない。
終了時には各seedにfood stockとactive food depositが残る。これだけで期間全体の食料安定や資源と繁殖の因果関係は断定しない。

## 再現性と完全なhash

3902とrepeatは**JSONL全バイトが一致**。summaryもdurationMsを除く全フィールドが一致した。
全4runでsnapshotSeriesHashを実際のJSONLバイトから再計算し、deterministicResultHashをcanonical summary payloadから再計算して一致を確認。

| seed | deterministicResultHash |
|---|---|
| 3901 | `61e753986cb51f17b3ec439d221e6ab0192a04cc4a028582f4d3f48e6293178e` |
| 3902 / repeat | `6071895d704e62a31de0b91ffbabea0d1ee2ba7a0cb4993c3ccebb9cd6b8ccae` |
| 3903 | `a328e403b17b915f1c0f7019e399f579decb0b62157053e779d3fead39fb219e` |

| seed | snapshotSeriesHash |
|---|---|
| 3901 | `490009759ba9280d069bae073a6124615ef7cb0594d4dac8aa01d157bb093f06` |
| 3902 / repeat | `2092e9dc33613e05d5654b08ab25aaa35c6ae2f0db73afe96238b767f8ce34b9` |
| 3903 | `e5450ab9edf3fbf0166b7f96f96996a0449016871cf9d6181ba82f200e10838b` |

| seed | finalStateHash |
|---|---|
| 3901 | `4529717010a21d1d5fa15041bb94fa9a6c0b58051c458eed1c75dc2b910b1b85` |
| 3902 / repeat | `ad773a01bb081a12a2b14160bdd28f9f9211f71f2450aafadc583f46b7727e79` |
| 3903 | `81339d9dd5fa799a14cae52f1f5fbee5fd8e7a72fde4e188019616d53d96724f` |

seedをhashの入力に含めたために結果hashが変わっただけではない。人口・出生数・資源量・resource layoutにも実際の差がある。

## Phase 0の問いへの回答

1. **vitalityが長期生存・子孫数に影響したか:** 未判定。100,000 ticksは約11.57人口日で、老年化18日・neutral寿命24〜32日より短い。死亡は0件、出生個体の寿命はすべて右打切りである。
2. **carryingCapacityが資源取得・繁殖に間接的に影響したか:** 未判定。形質・資源・出生にはseed間の差があるが、地形・親ペア・年齢・role等が混在し、相関さえこの集計だけから個体単位には評価できない。
3. **分散は世代をまたいで残るか:** 3902のG2では両形質の非ゼロ分散を観測した。ただしG2は3個体のみで、長期維持の結論ではない。
4. **資源密度で有利な形質が変わるか:** 未判定。今回の自然なseed差は環境条件を統制した比較ではない。
5. **lineageは単一系統へ急速に偏るか:** 観測した期間・期待祖先寄与の定義では、極端な集中なし。
6. **既存系だけで環境→選択圧feedbackを観測できるか:** 出生・成長・世代継承と環境の同時観測はできる。選択効果とmutation / drift / founder効果の分離は未了。

**判断: 新しいstrategy traitはまだ追加しない。** 次の研究では、生存・繁殖ルールを変えず、少なくともlineage-born cohortの実寿命を観測できる期間へ延長し、世代・年齢・role・環境を分けて評価する。
birthTick不明の創始個体は既存互換仕様で老衰しないため、vitalityの寿命効果分析から分離する。長期追試はCIに入れず、時間・メモリ上限と途中終了表示を維持する。

## 受入と再実行

- 同一seed/configの軽量smokeとseed sensitivity、neutral founder、raw trait bounds、production/entropy guard、schema、逐次JSONL・途中終了・出力先保護をテスト。
- runnerとengineが同じ条件で同じ最終WorldStateを返し、sample頻度やobserverがsimulationを変えないことを検証。
- ローカル関連テスト55件 pass / 0 fail（population・simulation・canary）。PRのGitHub Actions全体も成功: [CI run 37590160497](https://github.com/azumag/MoYoGarden/actions/runs/37590160497)。
- `src/` / persisted WorldState / schemaVersion=1 / production Worker / DO / deploy branchは変更しない。
- ガードは管理下のengineコードへの回帰境界であり、悪意ある任意JSを実行するセキュリティsandboxではない。
- 生の4runのJSONL、summary、実行条件、hash検証結果は納品の `evolution-phase0-results-2026-10-07.zip` に収録。永続的な比較基準として本書にcommit・完全なhash・測定値を残す。

厳密に今回のresult hashを再現する場合、実装commitをcheckoutし、対応するTypeScript buildを使用する（単に新しいmainでcommitラベルだけを付け替えない）。

```bash
node tools/evolution-canary.mjs --seed 3902 --ticks 100000 --sample-every 8640 \
  --max-runtime-ms 1200000 --commit 9df2e0a24656d8f1ba4a6c798dfef2127e2098af \
  --output /tmp/moyo-phase0-3902-new
```

出力先は新規ディレクトリを用いる。正常完走はexit 0、時間上限での中断はexit 2、その他のエラーはexit 1。
