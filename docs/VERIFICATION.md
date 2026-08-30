# 検証

```bash
npm run verify
```

現在の検査:

1. 同一seedから同一世界が生成される
2. 3勢力が文明ループを完了する
3. 局所知覚が範囲外を漏らさない
4. 未適用CommandがDO休止後も復元される
5. 取引が原子的に成立する
6. 新規DO領域が永続化されAlarmを設定する
7. CommandとAdminのtokenを分離する
8. DO再生成後のAlarmでCommandを適用する
9. ブラウザJavaScript構文
10. WebGL 2、WebSocket、外部CDN非依存の静的検査

この環境ではWrangler packageをネットワークから取得できないため、Cloudflare実ランタイム上の`wrangler dev`統合テストは未実施です。TypeScript型検査とDOのin-memory harnessは成功しています。
