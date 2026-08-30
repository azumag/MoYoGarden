# Godot 3D client

Godot 4.4以降でこのディレクトリを開きます。デフォルトではローカルの `http://127.0.0.1:8787` に接続します。

```bash
MOYO_API_URL=https://moyo-garden.YOUR_SUBDOMAIN.workers.dev \
MOYO_REGION=garden-1 \
MOYO_TOKEN=YOUR_COMMAND_OR_ADMIN_TOKEN \
godot --path clients/godot
```

Web公開版は `public/` の軽量WebGLクライアントです。このGodot版はネイティブクライアント、将来のWebエクスポート、より複雑なキャラクター制御の基礎として同じAPI境界を利用します。
