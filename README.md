# SSH MCP Server

Claude.ai からローカルネットワーク上の任意のサーバーに SSH 接続するための MCP (Model Context Protocol) サーバー。

## アーキテクチャ

```
Claude.ai (ブラウザ)
    │
    │ HTTPS (Anthropic Cloud経由)
    ▼
Cloudflare Tunnel
    │
    │ https://ssh-mcp.appserver.tokyo/mcp
    ▼
┌─────────────────────────────────┐
│  LXC Container (VMID: 400)     │
│  ssh-mcp-server                │
│                                │
│  Express + Streamable HTTP     │
│  Bearer Token Auth             │
│  ┌───────────────────────┐     │
│  │ SSH Session Manager   │     │
│  │ - Connection Pool     │     │
│  │ - 30min TTL           │     │
│  │ - Auto-cleanup        │     │
│  └───────┬───────────────┘     │
└──────────┼─────────────────────┘
           │ SSH (port 22)
           ▼
    ┌──────────────┐
    │ Proxmox Host │  192.168.70.226
    │ Other LXCs   │  192.168.70.xxx
    │ NAS / VMs    │  10.x.x.x
    │ Any SSH host │
    └──────────────┘
```

## ツール一覧

| ツール名 | 説明 |
|---------|------|
| `ssh_connect` | SSH接続を確立。session_idを返す |
| `ssh_execute` | 接続済みセッションでコマンドを実行 |
| `ssh_disconnect` | セッションを切断（個別 or 全切断） |
| `ssh_list_sessions` | アクティブなセッション一覧を取得 |
| `ssh_upload_file` | テキストファイルをSFTPでアップロード |
| `ssh_download_file` | テキストファイルをSFTPでダウンロード |

## セッション管理

- SSH接続はサーバー側でインメモリにプールされる
- 各MCPツール呼び出しは `session_id` でセッションを参照
- 30分間アイドル状態のセッションは自動切断
- Keepalive (10秒間隔) で接続を維持

## デプロイ手順

### 1. Proxmox上にLXCを作成

```bash
# Proxmoxホストで実行
LXC_ID=400 bash deploy-lxc.sh
```

または手動で：

```bash
# LXC内で
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

git clone https://github.com/DaisukeHori/ssh-mcp-server.git /opt/ssh-mcp-server
cd /opt/ssh-mcp-server
npm install
npx tsc

# .envを設定
cat > .env << EOF
PORT=3000
AUTH_TOKEN=$(openssl rand -hex 32)
REQUIRE_AUTH=true
EOF

# systemdサービス設定
cp deploy-lxc.sh /tmp/  # サービスファイルの内容を参照
systemctl enable --now ssh-mcp-server
```

### 2. Cloudflare Tunnel設定

`cloudflared` の config.yml に追加：

```yaml
ingress:
  - hostname: ssh-mcp.appserver.tokyo
    service: http://localhost:3000
    originRequest:
      noTLSVerify: true
```

### 3. Claude.aiでコネクター登録

1. Claude.ai → 設定 → コネクター → カスタムコネクターを追加
2. URL: `https://ssh-mcp.appserver.tokyo/mcp`
3. ヘッダー: `Authorization: Bearer <AUTH_TOKEN>`

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `PORT` | `3000` | HTTPサーバーのポート |
| `AUTH_TOKEN` | (必須) | Bearer認証トークン |
| `REQUIRE_AUTH` | `true` | `false`で認証を無効化（開発用） |

## 開発

```bash
npm install
npm run build
REQUIRE_AUTH=false npm start
```

ヘルスチェック：
```bash
curl http://localhost:3000/health
```

MCP テスト：
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

## セキュリティ考慮事項

- AUTH_TOKENは十分な長さ（64文字以上推奨）のランダム文字列を使用
- Cloudflare Tunnel経由のみでアクセス（直接ポート公開しない）
- SSHのパスワード/鍵はMCPリクエストで毎回送信される（サーバー側に保存しない）
- セッションはインメモリのみ（再起動で全消去）

## ライセンス

MIT
