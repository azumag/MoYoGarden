# API

Base URL例: `https://moyo-garden.YOUR_SUBDOMAIN.workers.dev`

全領域APIは`?region=garden-1`を受け取ります。省略時は`DEFAULT_REGION_ID`です。

## 読み取り

### `GET /api/meta`

利用可能領域、既定領域、バージョンを返します。

### `GET /api/health`

現在tick、pause、接続数、未処理Command数、tick間隔を返します。

### `GET /api/rules`

Command、資源、建物、知覚半径、認証方式を返します。

### `GET /api/world/snapshot`

完全な`WorldState`です。観測・デバッグ用です。

### `GET /api/agents`

領域内のBOT一覧です。

### `GET /api/agents/:id/perception?radius=6`

指定BOTの局所知覚です。半径は1〜12です。

### `GET /api/events?afterTick=-1&limit=100`

公開イベントを返します。

## WebSocket

### `GET /api/stream`

upgrade後、次の形式を接続直後とtick後に送ります。

```json
{
  "type": "snapshot",
  "state": { "tick": 42, "regionId": "garden-1" },
  "paused": false,
  "tickMs": 10000
}
```

## Command

`Authorization: Bearer <COMMAND_TOKEN>`が必要です。`ADMIN_TOKEN`でも許可されます。

### `POST /api/agents/:id/commands`

```json
{
  "id": "client-idempotency-key",
  "type": "move",
  "target": { "x": 10, "y": 6 }
}
```

Command type:

- `move`: `{ target }`
- `gather`: `{ resource, target? }`
- `build`: `{ structureType, target }`
- `deposit`: `{ structureId? }`
- `trade`: `{ targetAgentId, offer, request }`
- `set_autonomy`: `{ enabled }`
- `set_goal`: `{ goal }`
- `clear_task`

再試行するクライアントは安定した`id`を送ってください。処理済み・キュー済みIDは重複拒否されます。

## Admin

`Authorization: Bearer <ADMIN_TOKEN>`が必要です。

```text
POST /api/admin/tick     { "count": 1 }
POST /api/admin/pause    {}
POST /api/admin/resume   {}
POST /api/admin/reset    { "seed": 424242 }
```
