# Changelog

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
