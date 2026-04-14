# SSH MCP Server v2

Claude.ai からローカルネットワーク上の任意のサーバーに SSH 接続するための MCP サーバー。

## アーキテクチャ

```
Claude.ai (User A)  →  ?key=uk_xxx  →  ssh_connect → sess_abc123...
Claude.ai (User B)  →  ?key=uk_yyy  →  ssh_execute(sess_abc123) ← 共有可
Claude.ai (Admin)   →  ?key=ak_xxx  →  ssh_list_sessions (全ユーザー)
         │
         ▼
 Cloudflare Tunnel (HTTPS)
         │
         ▼
 ┌───────────────────────────────────────┐
 │  LXC: ssh-mcp-server                 │
 │                                       │
 │  ?key= ──→ KeyStore ──→ CallerContext │
 │                                       │
 │  session_token (SHA-256)              │
 │  = capability token (持ってれば使える) │
 │                                       │
 │  TTL: 未使用→1日 / 使用済→3ヶ月      │
 └───────────────┬───────────────────────┘
                 │ SSH
                 ▼
         ローカルネットワーク
```

## ツール一覧 (10)

### SSH操作

| ツール | Admin | User | session_token | 説明 |
|--------|:-----:|:----:|:-------------:|------|
| `ssh_connect` | ✗ | ✓ | — | SSH接続 → session_token返却 |
| `ssh_execute` | ✓ | ✓ | 必要 | コマンド実行 |
| `ssh_disconnect` | ✓ | ✓ | 必要 | セッション切断 |
| `ssh_list_sessions` | ✓全部 | ✓自分 | — | セッション一覧 |
| `ssh_upload_file` | ✓ | ✓ | 必要 | ファイルアップロード |
| `ssh_download_file` | ✓ | ✓ | 必要 | ファイルダウンロード |

### 管理

| ツール | Admin | User | 説明 |
|--------|:-----:|:----:|------|
| `user_key_create` | ✓ | ✗ | User Key発行 |
| `user_key_list` | ✓ | ✗ | User Key一覧 |
| `user_key_delete` | ✓ | ✗ | User Key削除 |
| `whoami` | ✓ | ✓ | 現在のキー情報 |

## 認証モデル

```
                  ┌────────────┐
                  │  ?key=xxx  │  URL パラメータ
                  └──────┬─────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        Admin Key              User Key
        (env: ADMIN_KEY)       (user-keys.json)
              │                     │
              │               ssh_connect()
              │                     │
              │                     ▼
              │              session_token
              │              (SHA-256, 共有可能)
              │                     │
              ▼                     ▼
        全セッション操作     トークン保持者が操作
```

## TTL

| 状態 | TTL |
|------|-----|
| 作成後 ssh_execute/upload/download 未実行 | 最終使用から **1日** |
| ssh_execute/upload/download を1回以上実行 | 最終使用から **3ヶ月** |

※ サーバー再起動で全セッション破棄（session_tokenは無効化）

## セットアップ

```bash
# 1. クローン & ビルド
git clone https://github.com/DaisukeHori/ssh-mcp-server.git
cd ssh-mcp-server && npm install && npx tsc

# 2. Admin Key生成 & 起動
export ADMIN_KEY=$(openssl rand -hex 32)
echo "Admin Key: $ADMIN_KEY"  # 保存！
node dist/index.js

# 3. Claude.ai コネクター登録
#    URL: https://ssh-mcp.appserver.tokyo/mcp?key=<ADMIN_KEY>
#    (User Keyを発行したら、そのkeyで別コネクターを追加)
```

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|:----:|------|
| `ADMIN_KEY` | ✓ | 管理者APIキー |
| `PORT` | — | HTTPポート (default: 3000) |
| `DATA_DIR` | — | user-keys.json保存先 (default: cwd) |

## ライセンス

MIT
