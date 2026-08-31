# MoYoGarden

AIエージェントや機械BOTが住民として行動し、集落・物流・市場を作っていく、BOT前提の永続型3Dワールドです。

## Production 0.3.1

本番のルート画面は、起動実績のある自己完結型WebGL 2レンダラーを使用します。PBR版でブラウザのモジュール読込が停止する障害が起きたため、glTF/PBR/LOD/影レンダラーは `pbr-preview` ブランチへ退避し、本番起動経路から分離しました。

- Cloudflare Durable Objectsによる権威ワールド状態
- SQLite-backed Durable Objectへの永続化
- 10秒単位の決定論的シミュレーション
- REST API / WebSocket / MCPブリッジ
- 外部CDN・外部3D素材に依存しないWebGL 2クライアント
- Cloudflare Workers BuildsによるGitHub連動デプロイ

3勢力12体のBOTが、木材・石材・食料を集め、キャンプ、倉庫、市場、工房を自律建築します。人間、ルールBOT、LLM、MCPクライアントは同じCommand APIから移動、採集、建築、運搬、取引、目標変更を指示します。

## 3D画面の操作

| 操作 | 内容 |
|---|---|
| 左ボタンを押しながらドラッグ | カメラ回転 |
| ホイールボタンを押しながらドラッグ | 地図をつかむ感覚で前後左右へ平行移動 |
| マウスホイール | ズーム |
| 左クリック | BOT選択 |
| 右クリック | 選択中BOTへの移動命令 |
| `W` `A` `S` `D` | カメラ基準で平行移動 |

中ボタンドラッグは旧版から上下左右とも反転しています。地図を右へドラッグするとカメラは左へ、上へドラッグするとカメラは後方へ移ります。

## ローカル起動

Node.js 22以降を使用します。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`http://127.0.0.1:8787`を開きます。localhostからの操作はトークン不要です。

```bash
npm run verify
```

検証には、決定論的シミュレーション、文明ループ、局所知覚、取引、認証、Durable Object休止後のCommand復元、ブラウザJavaScript構文、起動経路、キャッシュバスト、中ボタンドラッグ反転が含まれます。

## Cloudflareへ自動デプロイ

GitHub Actionsは使用しません。Cloudflare Dashboardで`azumag/MoYoGarden`をWorkers Buildsへ接続すると、以後は`main`へのpushをCloudflare自身が検出してデプロイします。

```text
Worker name:       moyo-garden
Production branch: main
Root directory:    /
Build command:     npm run build
Deploy command:    npx wrangler deploy
```

Runtime Secretとして次を設定します。

```text
COMMAND_TOKEN
ADMIN_TOKEN
```

本番URL：`https://moyo.bluemoon.works`

## API

`?region=garden-1`を省略すると既定領域を使います。

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

```bash
curl -X POST \
  'https://moyo.bluemoon.works/api/agents/agent-ember-builder/commands?region=garden-1' \
  -H "Authorization: Bearer $MOYO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"move-001","type":"move","target":{"x":8,"y":6}}'
```

## MCP

```bash
MOYO_API_URL=https://moyo.bluemoon.works \
MOYO_REGION=garden-1 \
MOYO_TOKEN=YOUR_COMMAND_TOKEN \
node tools/mcp.mjs
```

## PBR開発

glTF 2.0、metallic-roughness PBR、3段階LOD、ソフトシャドウを導入した実装は`pbr-preview`ブランチに保存しています。本番と分離したCloudflare Workerで起動・通信・MIME type・静的アセット配信を検証した後、段階的ローディングと自動フォールバックを付けて再導入します。

## License

MIT
