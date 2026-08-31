# Changelog

## 0.3.3 - 2026-08-31

- PBR版の起動を段階化し、GLB・API・環境光・影を待たず軽量LODで操作可能に変更
- ES module graph外に12秒の起動ウォッチドッグと安定版へのフォールバックを追加
- GLTFLoaderとRoomEnvironmentを遅延importへ変更
- GLBを最大2件ずつ読み込み、種類ごとのタイムアウト・構造検査・個別フォールバックを追加
- 読み込めたモデルだけをBOT・建物・資源へ段階的に差し替える処理を追加
- balanced/high/ultraの品質プロファイルを追加
- Three.jsをminified自己ホストランタイムへ変更
- PMREM環境光と影生成を初回描画後へ遅延
- 影の毎フレーム再生成をやめ、状態変化と移動中の間引き更新へ変更
- 水面のtransmission passを無効化し、clearcoatを維持した軽量PBRへ変更
- 高解像度版を別Worker `moyo-garden-pbr-preview` へ隔離する設定を追加

## 0.3.0 - 2026-08-31

- Three.jsベースのglTF 2.0レンダラーへ移行
- BOT、樹木、岩、キャンプ、倉庫、市場、工房の自己完結GLBモデルを追加
- metallic-roughness PBR、環境光、ACESトーンマッピングを追加
- 3段階LODと遠景用軽量モデルを追加
- PCFソフトシャドウと影受け地形を追加
- 水面を物理ベースマテリアルへ変更
- 中ボタンドラッグの上下左右を反転し、地図をつかむ操作へ変更
- Three.jsをビルド時に自己ホストする構成へ変更

## 0.2.0 - 2026-08-31

- Cloudflare Worker + SQLite-backed Durable Objectへ移植
- 10秒Alarm tickとWebSocket Hibernation API
- Command/Admin bearer token
- 外部依存なしのWebGL 2 3Dクライアント
- Godot 4ネイティブ3Dクライアントへ変更
- Workers BuildsのGitHub自動デプロイ構成
- DO休止後のCommand復元テスト

## 0.1.0

- ローカルNode.js版BOT-first world MVP
