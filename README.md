# SSH MCP Server

**Claude.aiをSSHクライアントにする。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-8B5CF6.svg)](https://modelcontextprotocol.io/)

> **エンドポイント:** `https://ssh-mcp.appserver.tokyo/mcp?key=YOUR_KEY`
> **LP:** [daisukehori.github.io/ssh-mcp-server](https://daisukehori.github.io/ssh-mcp-server/)

Claude.aiのチャットから `ssh_connect` するだけで、ローカルネットワーク上のどのサーバーにもSSH接続。返ってくる `session_token` はSHA-256のケイパビリティトークン — 会話履歴に自然に残り、次のメッセージでそのまま使えます。

Proxmox管理、LXCコンテナ操作、デプロイ、ログ確認、ファイル編集 — ブラウザさえあればどこからでも。

## なぜ必要か

Claude.aiにはコード実行環境がありますが、あなたのローカルサーバーにはアクセスできません。Claude DesktopやClaude Codeなら手元のターミナルが使えますが、**出先でスマホやブラウザだけの状況**では何もできません。

SSH MCPがあれば：

```
あなた: 「Proxmoxに繋いで。LXCの状態を確認して」

AI: SSH接続しました (session_token: sess_a3f8...)
    pct list の結果:
    VMID  Status  Name
    100   running web-app
    101   stopped dev-env
    400   running ssh-mcp

あなた: 「101を起動して、npm run buildして」

AI: pct start 101 → OK
    pct exec 101 -- bash -c "cd /opt/app && npm run build"
    Build completed successfully (12.3s)
```

これが**ブラウザのClaude.aiだけで**できます。

## アーキテクチャ

```
Claude.ai (ブラウザ / モバイル)
    │
    │  ?key=uk_xxx (URL パラメータ認証)
    ▼
Cloudflare Tunnel (HTTPS)
    │
    ▼
┌──────────────────────────────────────────┐
│  LXC Container: ssh-mcp-server           │
│                                          │
│  ┌──────────┐  ┌──────────────────────┐  │
│  │ Key Store │  │ SSH Session Manager  │  │
│  │           │  │                      │  │
│  │ Admin Key │  │ sess_abc → Host A    │  │
│  │ uk_hori   │  │ sess_def → Host B    │  │
│  │ uk_tanaka │  │ sess_ghi → Host C    │  │
│  └──────────┘  └──────────┬───────────┘  │
└────────────────────────────┼─────────────┘
                             │ SSH (port 22)
                             ▼
                  ┌──────────────────┐
                  │  Proxmox Host    │
                  │  LXC / VM        │
                  │  NAS / Router    │
                  │  Any SSH target  │
                  └──────────────────┘
```

## 認証モデル

```
               ?key=xxx (URLパラメータ)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     Admin Key             User Key
     (env変数)            (user-keys.json)
          │                     │
          │               ssh_connect()
          │                     │
          │                     ▼
          │              session_token
          │           (SHA-256 ケイパビリティ)
          ▼                     │
     全セッション閲覧      ┌────┴────┐
     User Key CRUD         │ 共有可能 │
                           └─────────┘
```

**3層の認証：**

| レイヤー | 目的 | 例 |
|:--|:--|:--|
| **Admin Key** | サーバー管理。User Key発行・全セッション閲覧 | `ak_a8f3b2c1...` |
| **User Key** | MCPアクセス。SSH接続の作成権 | `uk_84e17ac6...` |
| **Session Token** | SSH操作権。持っていれば誰でも使える | `sess_e7b2a4f1...` |

### マルチキー対応

`?key=` は複数指定可能。Admin Key と User Key の混在もOK。

```
?key=ak_xxx&key=uk_aaa&key=uk_bbb
```

| パターン | 例 | ssh_connect | ssh_list | admin操作 |
|:--|:--|:--|:--|:--|
| Admin のみ | `?key=ak_xxx` | ✗ | 全セッション | ✓ |
| User ×1 | `?key=uk_aaa` | ✓ (uk_aaa所有) | uk_aaaのみ | ✗ |
| User ×2 | `?key=uk_aaa&key=uk_bbb` | ✓ (uk_aaa所有) | uk_aaa ∪ uk_bbb | ✗ |
| Admin + User ×1 | `?key=ak_xxx&key=uk_aaa` | ✓ (uk_aaa所有) | 全セッション | ✓ |
| Admin + User ×2 | `?key=ak_xxx&key=uk_aaa&key=uk_bbb` | ✓ (uk_aaa所有) | 全セッション | ✓ |

- **ssh_connect** → Primary User Key（最初のUser Key）が所有者
- **ssh_list_sessions** → Admin Key がある場合は全セッション、なければ全User Keyのセッションの和集合
- **ssh_execute等** → session_tokenのケイパビリティ（キーの種類に関係なく操作可能）
- **admin操作** → Admin Keyが含まれている場合のみ実行可能

**典型的な使い方:**
- 普段使い: `?key=uk_hori`
- 管理者が全体管理: `?key=ak_xxx`
- 管理者が自分も作業: `?key=ak_xxx&key=uk_hori` ← 最強構成
- 他人のセッションも見たい: `?key=uk_hori&key=uk_tanaka`

## ツール一覧（10ツール）

### SSH操作

| ツール | Admin | User | session_token | 説明 |
|:--|:--:|:--:|:--:|:--|
| `ssh_connect` | ✗ | ✓ | — | SSH接続を確立。session_tokenを返す |
| `ssh_execute` | ✓ | ✓ | 必要 | シェルコマンドを実行 |
| `ssh_disconnect` | ✓ | ✓ | 必要 | セッションを明示的に切断 |
| `ssh_list_sessions` | ✓全部 | ✓自分のみ | — | アクティブセッション一覧 |
| `ssh_upload_file` | ✓ | ✓ | 必要 | SFTPでテキストファイルを送信 |
| `ssh_download_file` | ✓ | ✓ | 必要 | SFTPでテキストファイルを取得 |

### 管理（Admin Key専用 + 共通）

| ツール | Admin | User | 説明 |
|:--|:--:|:--:|:--|
| `user_key_create` | ✓ | ✗ | User Keyを新規発行 |
| `user_key_list` | ✓ | ✗ | 全User Keyを一覧表示 |
| `user_key_delete` | ✓ | ✗ | User Keyを削除 |
| `whoami` | ✓ | ✓ | 現在のキー情報を表示 |

## セッション管理

### session_token = ケイパビリティトークン

- `ssh_connect` が返す `sess_` で始まるSHA-256ハッシュ
- **持っていれば誰でも操作可能**（共有できる）
- SSH接続情報（host/password等）を逆算不可能
- Claude.aiの会話履歴に自然に残る → 次のメッセージで継続利用

### TTL（Time To Live）

| 状態 | TTL | 説明 |
|:--|:--|:--|
| 未使用 | 最終使用から**1日** | ssh_connect後、execute/upload/downloadを一度も実行していない |
| 使用済 | 最終使用から**3ヶ月** | execute/upload/downloadを1回以上実行済み |

- サーバー再起動で全セッション破棄（SSH接続はインメモリ）
- session_tokenのメタデータは永続化しない（シンプルさ優先）

## 🔒 セキュリティ

**Q: URLパラメータにキーを入れて大丈夫？**

- 通信は全て **HTTPS (Cloudflare Tunnel + TLS)** で暗号化
- Cloudflareのアクセスログにクエリパラメータが記録される可能性はあるが、Tunnel経由の自前サーバーなので外部に漏洩するリスクは限定的
- SSHパスワード/秘密鍵は **MCPリクエスト内でのみ使用** され、サーバー側に保存もログ出力もしない
- セッションは **インメモリのみ** （再起動で消去）
- User Keysは `user-keys.json` に平文保存（LXC内部のみアクセス前提）
- ソースコードは**全て公開**

**セキュリティ設計の要点：**
- Admin Key → 環境変数（サーバー内）
- User Key → MCP経由でCRUD（user-keys.json永続化）
- Session Token → SHA-256ハッシュ（推測不可能、共有可能）
- SSH認証情報 → リクエスト処理中のみ使用、保存しない

## クイックスタート（4ステップ）

### ステップ1: LXCにデプロイ

```bash
# LXC内で実行
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

git clone https://github.com/DaisukeHori/ssh-mcp-server.git /opt/ssh-mcp-server
cd /opt/ssh-mcp-server
npm install && npx tsc
```

### ステップ2: Admin Keyを生成して起動

```bash
# Admin Key生成
export ADMIN_KEY=$(openssl rand -hex 32)
echo "Admin Key: $ADMIN_KEY"  # ⚠️ 保存！

# テスト起動
node dist/index.js
# → http://localhost:3000/health で確認

# systemdサービス化
cat > /etc/systemd/system/ssh-mcp-server.service << EOF
[Unit]
Description=SSH MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ssh-mcp-server
Environment=ADMIN_KEY=$ADMIN_KEY
Environment=PORT=3000
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now ssh-mcp-server
```

### ステップ3: Cloudflare Tunnel設定

cloudflaredのconfig.ymlにingress追加：

```yaml
ingress:
  - hostname: ssh-mcp.appserver.tokyo
    service: http://localhost:3000
```

### ステップ4: Claude.aiでコネクター登録

**Admin接続（User Key発行用）：**
1. Claude.ai → Settings → Connectors → Add Custom Connector
2. URL: `https://ssh-mcp.appserver.tokyo/mcp?key=YOUR_ADMIN_KEY`

**User Key発行：**
```
あなた: 「horiというユーザーキーを作って」
AI: user_key_create("hori") → uk_84e17ac6...
```

**User接続（普段使い）：**
1. Claude.ai → Settings → Connectors → Add Custom Connector
2. URL: `https://ssh-mcp.appserver.tokyo/mcp?key=uk_84e17ac6...`

## 使用例

### 基本操作

```
あなた: 「Proxmoxに接続して」

AI: ssh_connect(host="192.168.70.226", username="root", password="xxx")
    → session_token: sess_a3f8b2c1e7d4...
    接続しました。

あなた: 「コンテナの一覧を見せて」

AI: ssh_execute(sess_a3f8b2c1e7d4..., "pct list")
    VMID  Status   Name
    100   running  web-app
    101   stopped  dev-env
    400   running  ssh-mcp
```

### ファイル操作

```
あなた: 「Nginxの設定ファイルを確認して」

AI: ssh_download_file(sess_..., "/etc/nginx/nginx.conf")
    [設定内容を表示]

あなた: 「server_nameをexample.comに変更して」

AI: ssh_upload_file(sess_..., "修正済み設定内容", "/etc/nginx/nginx.conf")
    ssh_execute(sess_..., "nginx -t && systemctl reload nginx")
    設定テスト通過、リロード完了。
```

### session_token共有

```
あなた (User A): 「Proxmoxに繋いで、session_tokenを教えて」
AI: sess_a3f8b2c1...

あなた (User B, 別の会話): 「sess_a3f8b2c1... でpct listして」
AI: ssh_execute(sess_a3f8b2c1..., "pct list")
    [結果表示]
```

## ⚠️ 重要な注意事項

### ssh_executeの破壊的コマンド

`ssh_execute` はリモートホストで**任意のシェルコマンドを実行**します。以下に特に注意：

| コマンド | リスク |
|:--|:--|
| `rm -rf /` | ファイルシステム全消去 |
| `pct destroy` | LXCコンテナ完全削除 |
| `systemctl stop` | サービス停止 |
| `dd if=/dev/zero` | ディスク破壊 |

→ AIは確認を求めますが、最終的な責任はユーザーにあります。

### サーバー再起動

- 全SSH接続がインメモリのため、再起動で**全セッション消失**
- session_tokenは無効化される
- User Keysは `user-keys.json` に永続化されているため影響なし

### 出力サイズ制限

| 対象 | 制限 |
|:--|:--|
| stdout / stderr | 各512KB（超過分は切り捨て） |
| ssh_download_file | 512KB（超過でエラー） |
| ssh_upload_file | 1MB |

大きなファイルは `ssh_execute` で `head`, `tail`, `cat | head -c 100000` を使用してください。

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|:--|:--:|:--|:--|
| `ADMIN_KEY` | ✓ | — | 管理者APIキー |
| `PORT` | — | `3000` | HTTPリッスンポート |
| `DATA_DIR` | — | `cwd()` | user-keys.json保存先 |

## FAQ

**Q: session_tokenを忘れた場合は？**
→ `ssh_list_sessions` で自分のセッション一覧を確認できます。User Keyで作成したセッションのトークンが表示されます。

**Q: 3ヶ月放置したセッションはどうなる？**
→ 自動切断されます。再度 `ssh_connect` してください。

**Q: User Keyを削除したら既存セッションはどうなる？**
→ セッションはTTL期限まで存続します。ただしそのUser Keyで新しい `ssh_list_sessions` や `ssh_connect` はできなくなります。session_tokenを知っていれば操作は可能です。

**Q: Admin Keyを変更したい場合は？**
→ 環境変数 `ADMIN_KEY` を変更してサーバーを再起動してください。既存のUser Keysとセッションには影響しません。

**Q: 複数のSSHホストに同時接続できる？**
→ はい。`ssh_connect` を複数回呼んで、それぞれ異なる `session_token` で操作できます。

**Q: Claude Desktop / Claude Code でも使える？**
→ はい。mcp-remoteを使えばStreamable HTTPサーバーに接続できます。
```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://ssh-mcp.appserver.tokyo/mcp?key=YOUR_KEY"]
    }
  }
}
```

## 技術スタック

TypeScript / Express / ssh2 / MCP SDK (Streamable HTTP) / Zod / Cloudflare Tunnel

## ライセンス

MIT License
