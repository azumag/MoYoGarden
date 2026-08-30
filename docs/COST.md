# Cloudflareランニングコスト試算

2026年8月31日時点のCloudflare公式料金を基準にしています。

## MVPのデフォルト

```text
領域数:             1
tick間隔:           10秒
Alarm実行:          8,640回/日、259,200回/月
状態保存:           8,640行/日
次回Alarm設定:      8,640行/日
SQLite書き込み合計: 約17,280行/日、518,400行/月
BOT数:              12
WebSocket:          Hibernation API
```

Cloudflare Freeの主な枠は次のとおりです。

| 項目 | Free枠 | MVP 1領域 |
|---|---:|---:|
| Workersリクエスト | 100,000/日 | 閲覧・APIアクセス分のみ |
| Durable Objectリクエスト | 100,000/日 | Alarmだけなら8,640/日 |
| DO duration | 13,000 GB-s/日 | tick処理時のみ。通常は大幅に下回る |
| SQLite行読み取り | 5,000,000/日 | 最大でもAlarm起動時に約8,640/日程度 |
| SQLite行書き込み | 100,000/日 | 約17,280/日＋コマンド数 |
| SQLite保存容量 | 5 GB | MVP状態はごく小さい |
| Static Assets | 無料・無制限 | 3Dクライアント一式 |
| Workers Builds | 3,000分/月 | 通常は1pushあたり数分未満 |

### 結論

1領域・少人数観測のMVPは、Cloudflare基盤費を **$0/月** にできる可能性が高い構成です。無料枠は日次上限なので、特定日の急増には注意します。

本番を止めにくくする場合はWorkers Paidを使います。最低料金は **$5/月** で、以下が含まれます。

- Workers: 1,000万リクエスト/月
- Durable Objects: 100万リクエスト/月
- DO duration: 400,000 GB-s/月
- SQLite行書き込み: 5,000万/月
- Workers Builds: 6,000分/月、その後$0.005/分

1領域・10秒tickはAlarmが月259,200回、行書き込みが月約518,400回なので、通常の閲覧やコマンドを加えても$5の付属枠内に収まりやすいです。

## 領域数とtick間隔

| 構成 | Alarm/日 | SQLite書き込み/日 | Free枠の見立て |
|---|---:|---:|---|
| 1領域・10秒tick | 8,640 | 17,280 | 余裕あり |
| 4領域・10秒tick | 34,560 | 69,120 | コマンド分を含めても現実的 |
| 5領域・10秒tick | 43,200 | 86,400 | 書き込み上限に近づく |
| 1領域・3秒tick | 28,800 | 57,600 | 1領域なら可能、余裕は小さい |
| 2領域・3秒tick | 57,600 | 115,200 | Freeの書き込み上限超過 |

このためMVPでは、見た目をクライアント補間に任せて10秒tickにしています。戦闘など短い反応が必要な領域だけtickを細かくする方が効率的です。

## WebSocketと3D配信

ブラウザへ送るWebSocketの**送信メッセージはDOリクエスト課金の対象外**です。Hibernation APIを使うため、接続しているだけでDOが常時duration課金される構造にもしていません。

3DクライアントはWorkers Static Assetsです。静的アセットへのリクエストは無料・無制限で、アセット保存にも追加料金はありません。`/api/*`だけWorkerを先に実行し、HTML、CSS、JavaScriptは直接Static Assetsから返します。

## 別料金になるもの

Cloudflare基盤費には、次は含まれません。

- OpenAI、Anthropic、Gemini等の外部LLM API
- Workers AIを利用する場合の推論量
- 独自ドメインの登録・更新費
- 将来R2へ保存する長期リプレイや大量ログの超過分

AIエージェントを常時LLMで考えさせると、ゲームサーバーより推論費の方が大きくなります。MVPでは移動・採集・建築を決定論的コードで処理し、LLMは目標設定や外交など低頻度判断だけに使う前提です。

## 公式資料

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
