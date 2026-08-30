# MoYoGarden

AIエージェントや機械BOTが住民として行動し、集落・物流・市場を作っていく**BOT前提の永続型3Dワールド**です。

現在のMVPは、1つのCloudflare Workerに次をまとめています。

- Cloudflare Durable Objectsによる権威ワールド状態
- SQLite-backed Durable Objectへの永続化
- 10秒単位の決定論的シミュレーション
- REST API / WebSocket / MCPブリッジ
- 外部ライブラリ不要のWebGL 2ブラウザ3Dクライアント
- 同じAPIを利用するGodot 4のネイティブ3Dクライアント
- Cloudflare Workers BuildsによるGitHub連動デプロイ

## 現在できること

3勢力12体のBOTが、木材・石材・食料を集め、キャンプ、倉庫、市場、工房を自律建築します。人間・ルールBOT・LLM・MCPクライアントは、すべて同じCommand APIから移動、採集、建築、運搬、取引、目標変更を指示します。

ブラウザ版では、起伏と水面を持つ地形、複数本からなる森林、岩石群、果実の茂み、建物ごとの外観、職業別装備を持つBOTを手続き生成した3D空間で観測できます。左クリックでBOTを選択し、右クリックで移動命令を送ります。

## 3D画面の操作

| 操作 | 内容 |
|---|---|
| 左ボタンを押しながらドラッグ | カメラ回転 |
| ホイールボタンを押しながらドラッグ | カメラ基準で前後左右へ平行移動 |
| マウスホイール | ズーム |
| 左クリック | BOT選択 |
| 右クリック | 選択中BOTへの移動命令 |
| `W` `A` `S` `D` | カメラ基準で平行移動 |

ホイールボタンのドラッグはWASDと同じ向きで移動します。上へドラッグすると前進、下へドラッグすると後退、左右へのドラッグで横移動します。

## ローカル起動

Node.js 22以降を使用します。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`http://127.0.0.1:8787` を開きます。localhostからの操作はトークン不要です。

```bash
npm run verify
```

検証には、決定論的シミュレーション、文明ループ、局所知覚、取引、認証、Durable Object休止後のコマンド復元、詳細3Dクライアントの構文・静的検査が含まれます。

## Cloudflareへ自動デプロイ

GitHub Actionsは使いません。Cloudflareダッシュボードで `azumag/MoYoGarden` を一度だけWorkers Buildsへ接続すると、以後は`main`へのpushをCloudflare自身が検出してデプロイします。

設定値は次のとおりです。

```text
Worker name:       moyo-garden
Production branch: main
Root directory:    /
Build command:     npm run build
Deploy command:    npx wrangler deploy
```

本番のSecretとして、異なる長い値を設定します。

```text
COMMAND_TOKEN
ADMIN_TOKEN
```

詳細手順は [`docs/CLOUDFLARE_DEPLOY.md`](docs/CLOUDFLARE_DEPLOY.md) にあります。

## ランニングコスト

MVPのデフォルトは1領域・10秒tickです。1日あたり8,640回のAlarmと、状態保存＋次回Alarm設定で約17,280行の書き込みになります。Cloudflare FreeのDurable Objects枠内に十分収まり、静的3Dアセットの配信は無料・無制限です。

したがって、小規模MVPはCloudflare費用 **$0/月** で運用可能です。安定運用ではWorkers Paidの最低料金 **$5/月** を見込めば、1領域の利用量は付属枠に大きく収まります。LLM推論料金はCloudflare基盤費とは別で、通常はこちらが主要コストになります。

計算根拠と領域数別の目安は [`docs/COST.md`](docs/COST.md) を参照してください。

## API

主な公開エンドポイントです。`?region=garden-1`を省略すると既定領域を使います。

```text
GET  /api/meta
GET  /api/health
GET  /api/rules
GET  /api/world/snapshot
GET  /api/agents
GET  /api/agents/:id/perception?radius=6
GET  /api/events?afterTick=-1&limit=100
GET  /api/stream                         WebSocket
POST /api/agents/:id/commands            COMMAND_TOKEN
POST /api/admin/tick                     ADMIN_TOKEN
POST /api/admin/pause                    ADMIN_TOKEN
POST /api/admin/resume                   ADMIN_TOKEN
POST /api/admin/reset                    ADMIN_TOKEN
```

本番では次のようにBearer tokenを送ります。

```bash
curl -X POST \
  'https://moyo.bluemoon.works/api/agents/agent-ember-builder/commands?region=garden-1' \
  -H "Authorization: Bearer $MOYO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"move-001","type":"move","target":{"x":8,"y":6}}'
```

完全な仕様は [`docs/API.md`](docs/API.md) にあります。

## MCP

Cloudflare上のHTTP APIをstdio MCPへ変換する薄いブリッジです。

```bash
MOYO_API_URL=https://moyo.bluemoon.works \
MOYO_REGION=garden-1 \
MOYO_TOKEN=YOUR_COMMAND_TOKEN \
node tools/mcp.mjs
```

設定例は [`examples/mcp-config.json`](examples/mcp-config.json) です。

## 設計上の要点

- `WorldState`は描画ノードと分離したJSONデータ
- `simulate(state, commands)`はseed管理された決定論的tick
- 人間、BOT、LLM、MCPは同じCommand境界を使用
- 一般BOTには完全ワールドではなく局所知覚を返す
- 1領域を1 Durable Objectへ割り当てる
- WebSocket Hibernation APIを使い、接続中のアイドル課金を避ける
- コマンドキューもSQLiteへ保存し、DOの休止・再生成で命令を失わない
- 静的3Dクライアントは外部CDN・外部画像素材なし

詳しくは [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。

## 現在のMVP外

戦闘・負傷・死亡、複数領域間の移動、契約・雇用・融資、政治・法律、プレイヤーアカウント、BOT別capability token、差分同期、世界新聞は次段階です。

## License

MIT
