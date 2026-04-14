# SSH MCP Server

Claude.ai からローカルネットワーク上の任意のサーバーに SSH 接続するための MCP (Model Context Protocol) サーバー。

## アーキテクチャ

```
Claude.ai User A ──┐                    
Claude.ai User B ──┤  HTTPS (Anthropic Cloud)
Claude.ai User C ──┘
    │
    ▼
Cloudflare Tunnel (ssh-mcp.appserver.tokyo)
    │
    ▼
┌────────────────────────────────────────┐
│  LXC Container (ssh-mcp)              │
│                                        │
│  ┌──────────────┐  ┌───────────────┐  │
│  │ Token Store   │  │ SSH Session   │  │
│  │ (tokens.json) │  │ Manager       │  │
│  │               │  │               │  │
│  │ tok_0001 Admin│  │ User A → ssh1 │  │
│  │ tok_0002 UserA│  │ User A → ssh2 │  │
│  │ tok_0003 UserB│  │ User B → ssh3 │  │
│  └──────────────┘  └───────┬───────┘  │
└────────────────────────────┼──────────┘
                             │ SSH (port 22)
                             ▼
                    ┌──────────────┐
                    │ Proxmox Host │
                    │ LXC / VM     │
                    │ NAS / etc    │
                    └──────────────┘
```

## マルチユーザー & トークン管理

OpenAI Assistants API の Thread パターンに似た設計:

1. **初回起動時**: Adminトークンが自動生成される（ログに表示、1回限り）
2. **Admin** が `admin_token_create` で各ユーザー用トークンを発行
3. **各ユーザー** は自分のトークンでClaude.aiのカスタムコネクターを登録
4. **SSHセッション** はトークン単位でスコープ（他ユーザーのセッションは見えない）
5. **Admin** は全セッションの閲覧・操作が可能

## ツール一覧 (10ツール)

### SSH操作 (全ユーザー)

| ツール | 説明 |
|--------|------|
| `ssh_connect` | SSH接続を確立。session_idを返す |
| `ssh_execute` | コマンド実行（最大10分タイムアウト） |
| `ssh_disconnect` | セッションを切断（個別 or 全切断） |
| `ssh_list_sessions` | 自分のアクティブセッション一覧 |
| `ssh_upload_file` | SFTPでテキストファイル送信 |
| `ssh_download_file` | SFTPでテキストファイル取得 |

### 管理 (Admin専用 + 共通)

| ツール | 説明 |
|--------|------|
| `admin_token_create` | 🔒 新しいAPIトークンを発行 |
| `admin_token_list` | 🔒 全トークン一覧（トークン文字列は部分表示） |
| `admin_token_revoke` | 🔒 トークンを失効 |
| `admin_whoami` | 現在のトークン情報を表示 |

## セッション管理

- SSH接続はサーバー側でインメモリにプール
- `session_id` + `token_id` でセッションをスコープ
- 30分間アイドル状態のセッションは自動切断
- Keepalive (10秒間隔) で接続を維持

## デプロイ手順

### 1. LXCにデプロイ

```bash
# LXC内で
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

git clone https://github.com/DaisukeHori/ssh-mcp-server.git /opt/ssh-mcp-server
cd /opt/ssh-mcp-server
npm install
npx tsc

# 初回起動（Adminトークンが表示される）
node dist/index.js
# → 表示されたトークンを保存！
```

### 2. systemdサービス

```bash
cat > /etc/systemd/system/ssh-mcp-server.service << 'EOF'
[Unit]
Description=SSH MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ssh-mcp-server
Environment=PORT=3000
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now ssh-mcp-server
```

### 3. Cloudflare Tunnel設定

`cloudflared` の config.yml に追加:

```yaml
ingress:
  - hostname: ssh-mcp.appserver.tokyo
    service: http://localhost:3000
```

### 4. Claude.aiでコネクター登録

1. Claude.ai → 設定 → コネクター → カスタムコネクターを追加
2. URL: `https://ssh-mcp.appserver.tokyo/mcp`
3. 認証ヘッダー設定で Bearer Token を入力

## トークン運用フロー

```
[Admin] Claude.ai →  admin_token_create(label="tanaka", is_admin=false)
                     → tok_0002: sshm_abc123...  ← これをtanakaさんに渡す

[tanaka] Claude.ai → 設定 → コネクター → URL + Bearer sshm_abc123...
                   → ssh_connect(host="192.168.70.226", username="root", password="xxx")
                   → ssh_execute(session_id="ssh-xxx-001", command="pct list")
```

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `PORT` | `3000` | HTTPサーバーのポート |
| `DATA_DIR` | `cwd()` | tokens.jsonの保存先 |

## セキュリティ考慮事項

- トークンは `sshm_` + 64文字のランダム hex
- tokens.json にハッシュではなく平文で保存（LXC内部のみアクセス前提）
- Cloudflare Tunnel経由のみでアクセス（直接ポート公開しない）
- SSHパスワード/鍵はMCPリクエストで毎回送信（サーバー側に保存しない）
- セッションはインメモリのみ（再起動で全消去、トークンは永続）

## ライセンス

MIT
