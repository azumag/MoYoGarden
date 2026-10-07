# Evolution canary — Phase 0

Issue #40 の、既存人口動態・資源・2形質を観測する単一リージョン実験です。
実験はローカルメモリ上の `WorldRuntime.tick()` で進み、Worker、Durable Object、
Cloudflare binding、production state には接続しません。`src/` と WorldState schemaVersion=1
は変更せず、fitness score、strategy trait、人口上限、繁殖・生存ロジックの上書きを導入しません。

## 実行

```bash
npm run experiment:evolution -- --seed 3902 --ticks 100000 --sample-every 8640 \
  --max-runtime-ms 900000 --output /tmp/moyo-evolution-3902
```

出力先は**存在しない新規ディレクトリ**を指定します。既存結果を上書きせず、URL、UNC、
symlink、`.wrangler` などの予約パスを拒否します。`--output` を省略すると
`artifacts/evolution-canary/seed-<seed>-ticks-<ticks>` です。同じ条件の再実行にも新しい出力先が必要です。

seed は unsigned 32-bit 整数、ticks / sample-every / max-runtime-ms は正の整数です。
小数、指数文字列、`12x` のような入力を部分的に解釈しません。

通常は checkout の Git HEAD（CIでは GITHUB_SHA）を記録します。オフラインbundleから実行する場合は、
検証した元commitを `--commit <SHA>` で明示します。bundleはCI artifactとして7日保持します。
長期runはCIで実行しません。オフライン実験にはコンパイル済みコードを利用できます。

```bash
node tools/evolution-canary.mjs --seed 3901 --ticks 100000 --sample-every 8640 \
  --commit <verified-commit> --output /tmp/moyo-evolution-3901
```

## 出力契約（artifact schemaVersion=1）

機械可読schemaは `tools/evolution-canary.schema.json` の `$defs.snapshot` / `$defs.summary`。
WorldStateのschemaとは独立です。

### snapshots.jsonl

tick 0、sample-every の倍数、最終tickを重複なく記録します。CLIは各行をその時点で書き込み、
snapshot全系列をメモリに保持しません。summaryは系列全体を重複収録しません。

- `population`: living / infant / juvenile / adult / elder、累積births / deaths、extinct。
- `traits`: founderCount / lineageBornCount、vitality / carryingCapacity の count / mean / min / max /
  variance / p10 / p50 / p90。形質欠落は既存 `normalizedHeritableTraits` と同じneutral 1.0。
- `environment`: faction資源、deposit種別総量・active件数・depleted件数、resourceLayoutHash、
  structure種別件数、living agent role別件数。

分散は母分散。percentileはソート済み配列の `round((n-1)*p)` 番目を採用します。
統計は小数点以下12桁へ丸めます。対象0件の分布は count=0、統計値は全て **null** であり、
絶滅を形質が0へ進化したと誤解釈しません。初期→最終のtrait deltaも対象0件ならnullです。

births/deathsは毎tickのliving ID差分から数えます。sample間で出生・死亡しても取りこぼさず、
上限のあるWorldState.eventsには依存しません。未知parent、ID再利用、範囲外のraw inherited traitは
正常化で隠さず実験を失敗させます。

### summary.json

`run` は commit / seed / requestedTicks / completedTicks / sampleEvery / simulationConfig /
world extent / completed / stopReason / 人口日と寿命の定数 / engineHash を記録します。
`initialPopulation` / `finalPopulation`、`lineage`、初期・最終trait分布とdelta、最終資源状態、
3種類のhash、実測durationMsとruntimeLimitMsを出します。

`lineage` はobservedAgents / founders / lineageBorn / births / deaths / extinctionTick /
maxGeneration、世代ごとの生存・死亡数、出生時形質分布、子数分布を集計します。
創始個体をgeneration 0、子を `max(parent generation)+1` とします。世代は重複して生存します。generation 0のAtBirth欄は出生時ではなく初期観測値です。

- `completedLifespan`: birthTickが既知で、run中に死亡を観測した個体だけの実寿命。
- `unknownBirthDateDeaths`: birthTick不明の創始個体等の死亡数。tick 0を架空の出生時刻にしません。
- `rightCensoredKnownLifetimes`: birthTick既知で終了時に生存している個体数。寿命が確定していません。
- `topFounderConcentration`: 生存個体の**期待祖先寄与率**の最大値。創始個体自身は重み1、
  子は両親の寄与を1/2ずつ引き継ぎ、全生存個体で平均します。重複祖先も加算され、全founderの寄与率の和は1です。
  全滅時はnullです。遺伝的因果効果の推定値ではありません。
- `topFounders`: 上位8 founderの寄与率、重複排除したdescendant数とliving descendant数。
  descendant数はfounder間で重なりますが、寄与率は保存されます。

## 決定論とhash

初期worldは `createInitialWorld`、tickは `WorldRuntime` の既存 xorshift32 rngState、
遺伝は既存の親混合＋ID由来のbounded mutationをそのまま使います。runner独自の乱数はありません。
`submit()` は呼ばず、Date.now / Math.random / cryptoの外部entropy経路も実験中に拒否します。

- `snapshotSeriesHash`: canonical JSON各行＋LFを逐次SHA-256化。出力JSONLを直接検証できます。
- `finalStateHash`: 最終WorldState全体のcanonical JSONのSHA-256。集計にない内部状態の変化も検出します。
- `deterministicResultHash`: summaryから durationMs / runtimeLimitMs / このhash自身を除いた値のcanonical JSONのSHA-256。
- `run.engineHash`: 使用した8つの純粋engine moduleのファイル名とSHA-256から作るfingerprint。

canonical JSONはobject keyをUTF-16文字列の大小でソートし、array順序を保ちます。
同一commit・engine build・seed・tick数・configならsnapshot系列と結果hashが再現します。
比較時はNode/compiler環境も記録してください。出力先や測定時間は結果hashを変えません。

max-runtime-msによる中断は実測時間に依存するため、到達tick数は実行ごとに異なりえます。
終了code **2** と completed=false / stopReason=max-runtime-ms を返し、到達済みprefixの結果を保存します。
完走codeは0、入力・I/O・guard等のエラーは1です。summaryがないJSONLだけのrunも完走扱いにしません。
ガードや書き込みが失敗した場合に成功summaryを捏造しません。上限はtick境界で確認するsoft limitです。

## 隔離境界

`evolution-isolation.mjs` はengineの8 moduleと静的依存をimport前に検査し、built-in network/storage、
SDK、Worker/DO、動的import、production参照を拒否します。global network APIとentropy APIは
import評価時・実行時に拒否し、例外・重複実行後も元に戻します。設定できないguardはfail-closedです。
本番のbinding・storageをrunnerへ渡す経路はありません。

これは管理下のコードに対する**回帰ガード**で、悪意ある任意JavaScriptを安全に実行するsandboxではありません。
任意プラグイン、persisted production snapshot、外部URL、ユーザーcallbackをCLIからロードしません。
ローカル出力先についても、別プロセスが同時にsymlinkを差し替えるような敵対的filesystemは対象外です。

## 実験の読み方

人口1日は8,640ticks、老年化は18日、neutral寿命は24〜32日（vitality倍率適用前）です。
創始個体にはbirthTickがなく、現行互換仕様上は老衰しません。創始個体の長期生存を
vitalityの選択効果として扱わないでください。

まず最低3 seedで数人口日まで観測し、時間・人口・資源推移を確認します。可能なら成熟・次世代まで延長します。
世代が進まない、出生がない、寿命を観測する期間に届かない結果も、そのまま報告対象です。
形質平均の変化だけでは自然選択とmutation / drift / founder効果を分離できません。
runnerはselectionの成功・失敗を判定せず、Phase 1の新strategy trait導入は実験結果のレビューで判断します。
