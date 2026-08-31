# Changelog

## 0.3.1 - 2026-08-31

- 本番の起動経路を実績のある自己完結型WebGL 2レンダラーへ復旧
- glTF/PBRのモジュール読込停止が本番画面を塞がないよう分離
- PBR実装を`pbr-preview`ブランチへ保存
- JavaScriptとCSSのURLへバージョンを付け、古いブラウザキャッシュを回避
- 起動エラーと12秒ウォッチドッグをローディング画面へ表示
- 中ボタンドラッグの上下左右を反転し、地図をつかむ操作へ変更
- Production buildからThree.jsとGLB生成を外し、確実にデプロイできる経路へ戻した

## 0.3.0 - 2026-08-31

- Three.jsベースのglTF 2.0レンダラーを試験導入
- BOT、樹木、岩、キャンプ、倉庫、市場、工房の自己完結GLBモデルを追加
- metallic-roughness PBR、環境光、ACESトーンマッピングを追加
- 3段階LODと遠景用軽量モデルを追加
- PCFソフトシャドウと影受け地形を追加

この実装は起動障害の調査中で、`pbr-preview`ブランチに退避しています。

## 0.2.0 - 2026-08-31

- Cloudflare WorkerとSQLite-backed Durable Objectへ移植
- WebGL 2の3D観測画面を追加
- BOT API、WebSocket、MCPブリッジを追加
- Cloudflare Workers BuildsによるGitHub連動デプロイを追加
