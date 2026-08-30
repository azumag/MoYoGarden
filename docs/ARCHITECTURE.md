# アーキテクチャ

## 全体

```text
Browser WebGL 3D ─┐
Godot 3D client ──┼── HTTP / WebSocket ── Cloudflare Worker
Rule / LLM BOT ───┤                           │ regionId routing
MCP bridge ───────┘                           ▼
                                      RegionDurableObject
                                      SQLite state + Alarm
                                             │
                                      deterministic tick
```

Workerは`/api/*`を処理し、それ以外はStatic Assetsへ渡します。HTML、CSS、JavaScriptの配信はWorker invocationを発生させません。

## 1領域＝1 Durable Object

`REGION_IDS`に許可したIDだけを`idFromName(regionId)`へ変換します。任意の文字列で無制限にDOを作られないようにしています。

Durable Objectは次を1行のJSONとしてSQLiteへ保存します。

- `WorldState`
- 未適用Commandキュー
- pause状態
- 最終更新時刻

Command受理直後にも保存するため、tick前にDOが休止・再生成されても命令が消えません。

## tick

デフォルトは10秒です。

1. AlarmがDOを起動
2. 永続状態と未適用Commandを復元
3. `simulate(state, commands)`を1回実行
4. 新状態をSQLiteへ保存
5. WebSocket購読者へ完全snapshotを送信
6. 次のAlarmを設定

現在は完全snapshot同期です。次段階では接続時snapshot＋revision付きevent diffへ変更します。

## 決定論性

シミュレーションは壁時計を参照せず、`WorldState.rngState`を使うseed付き擬似乱数で進行します。同じ状態、同じCommand列、同じ設定なら同じ結果になります。

## 描画

### ブラウザ

`public/app.js`は外部CDNを使わないWebGL 2レンダラーです。

- 地形を1つのメッシュへ結合
- 資源・建物・BOTを低ポリゴン形状で手続き生成
- snapshot間を補間して移動表示
- orbit camera、ray-plane picking
- WebSocket失敗時はHTTP pollingへフォールバック

### Godot

`clients/godot`は同じAPIを使うGodot 4の3Dクライアントです。ネイティブ版、将来のWebエクスポート、複雑なアニメーション・入力処理の土台です。

## 認証

- GETとWebSocket観測は公開
- 通常Commandは`COMMAND_TOKEN`または`ADMIN_TOKEN`
- 管理操作は`ADMIN_TOKEN`のみ
- localhostの`wrangler dev`は開発用に認証を省略

MVPは共有tokenです。次段階ではプレイヤー、所有BOT、許可ツール、行動予算を含むcapability tokenへ移行します。

## 局所知覚

外部BOTは通常`/perception`を使います。完全snapshotは観測画面・デバッグ用です。局所知覚には、自分、自勢力情報、視界内の地形・BOT・施設、関連イベントだけを含めます。

## コスト設計

- 10秒tickでAlarmとSQLite書き込みを削減
- Static AssetsはWorkerを通さない
- WebSocket Hibernation APIで接続中のアイドルdurationを避ける
- 位置を高頻度同期せずクライアント補間
- LLMは高水準判断だけに限定
