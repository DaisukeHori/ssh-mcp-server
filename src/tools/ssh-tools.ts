import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHSessionManager } from "../services/ssh-session-manager.js";

export function registerSSHTools(server: McpServer, manager: SSHSessionManager): void {
  // ─────────────────────────────────────────────
  // ssh_connect
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_connect",
    {
      title: "SSH接続",
      description: `Establish a new SSH connection to a remote host. The connection is kept alive server-side and can be reused across multiple tool calls via its session ID.

Args:
  - host (string): Hostname or IP address (e.g. "192.168.70.226")
  - port (number, optional): SSH port (default: 22)
  - username (string): SSH username (e.g. "root")
  - password (string, optional): Password authentication
  - private_key (string, optional): Private key content (PEM format)
  - passphrase (string, optional): Passphrase for encrypted private key
  - label (string, optional): Human-readable label (e.g. "proxmox-host")

Returns:
  JSON with session_id, host, username, and connection details.

Examples:
  - Connect to Proxmox: host="192.168.70.226", username="root", password="xxx"
  - Connect with key: host="10.0.0.5", username="deploy", private_key="-----BEGIN OPENSSH..."
  - Connect with label: host="192.168.70.100", username="root", password="xxx", label="lxc-web-01"`,
      inputSchema: {
        host: z.string().min(1).describe("Hostname or IP address"),
        port: z.number().int().min(1).max(65535).default(22).describe("SSH port (default: 22)"),
        username: z.string().min(1).describe("SSH username"),
        password: z.string().optional().describe("Password for authentication"),
        private_key: z.string().optional().describe("Private key content (PEM format)"),
        passphrase: z.string().optional().describe("Passphrase for encrypted private key"),
        label: z.string().optional().describe("Human-readable label for this session"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const session = await manager.connect({
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.password,
          privateKey: params.private_key,
          passphrase: params.passphrase,
          label: params.label,
        });

        const result = {
          session_id: session.id,
          host: session.host,
          port: session.port,
          username: session.username,
          connected_at: session.connectedAt.toISOString(),
          label: session.label ?? null,
          message: `Connected successfully. Use session_id "${session.id}" for subsequent commands.`,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Connection failed: ${msg}` }],
        };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_execute
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_execute",
    {
      title: "SSHコマンド実行",
      description: `Execute a shell command on a connected SSH session. Each command runs in a new shell context (non-interactive). For multiple commands, join them with && or ;.

Args:
  - session_id (string): Session ID from ssh_connect
  - command (string): Shell command to execute
  - timeout_ms (number, optional): Timeout in milliseconds (default: 120000 = 2 minutes, max: 600000 = 10 minutes)

Returns:
  JSON with exit_code, stdout, stderr, and duration_ms.

Examples:
  - Check uptime: command="uptime"
  - List containers: command="pct list"
  - Multi-command: command="cd /opt/app && git pull && npm run build"
  - Long-running: command="apt update && apt upgrade -y", timeout_ms=300000

Error Handling:
  - If session not found, reconnect with ssh_connect
  - If command times out, try increasing timeout_ms or splitting the command`,
      inputSchema: {
        session_id: z.string().min(1).describe("Session ID from ssh_connect"),
        command: z.string().min(1).max(10000).describe("Shell command to execute"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(600000)
          .default(120000)
          .describe("Command timeout in ms (default: 120000, max: 600000)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const result = await manager.execute(
          params.session_id,
          params.command,
          params.timeout_ms
        );

        const output = {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          success: result.exitCode === 0,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Execution failed: ${msg}` }],
        };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_disconnect
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_disconnect",
    {
      title: "SSH切断",
      description: `Disconnect an SSH session. Optionally disconnect all sessions at once.

Args:
  - session_id (string, optional): Session ID to disconnect. Omit to disconnect ALL sessions.

Returns:
  Confirmation message with disconnected session details.`,
      inputSchema: {
        session_id: z
          .string()
          .optional()
          .describe("Session ID to disconnect. Omit to disconnect all sessions."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (params.session_id) {
        const success = manager.disconnect(params.session_id);
        if (success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  disconnected: params.session_id,
                  remaining_sessions: manager.sessionCount,
                }),
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Session '${params.session_id}' not found. Use ssh_list_sessions to see active sessions.`,
              },
            ],
          };
        }
      } else {
        const count = manager.disconnectAll();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                disconnected_count: count,
                message: `All ${count} session(s) disconnected.`,
              }),
            },
          ],
        };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_list_sessions
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_list_sessions",
    {
      title: "SSHセッション一覧",
      description: `List all active SSH sessions with their connection details, idle time, and labels.

Returns:
  JSON array of sessions with id, host, port, username, connectedAt, lastUsedAt, idleSeconds, and label.
  Sessions idle for more than 30 minutes are automatically cleaned up.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sessions = manager.listSessions();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: sessions.length,
                sessions,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_upload_file
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_upload_file",
    {
      title: "SSHファイルアップロード",
      description: `Upload text content as a file to the remote host via SFTP.

Args:
  - session_id (string): Session ID from ssh_connect
  - content (string): File content to upload (text only, max ~1MB)
  - remote_path (string): Absolute path on the remote host (e.g. "/tmp/script.sh")

Returns:
  Confirmation with remote path and size.

Examples:
  - Upload config: content="server { listen 80; }", remote_path="/etc/nginx/conf.d/app.conf"
  - Upload script: content="#!/bin/bash\\necho hello", remote_path="/tmp/test.sh"`,
      inputSchema: {
        session_id: z.string().min(1).describe("Session ID from ssh_connect"),
        content: z
          .string()
          .max(1048576)
          .describe("File content to upload (text, max ~1MB)"),
        remote_path: z
          .string()
          .min(1)
          .describe("Absolute path on the remote host"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        await manager.uploadFile(
          params.session_id,
          params.content,
          params.remote_path
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                uploaded: params.remote_path,
                size_bytes: Buffer.byteLength(params.content, "utf-8"),
                message: `File uploaded to ${params.remote_path}`,
              }),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Upload failed: ${msg}` }],
        };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_download_file
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_download_file",
    {
      title: "SSHファイルダウンロード",
      description: `Download a text file from the remote host via SFTP. Max file size: 512KB.

Args:
  - session_id (string): Session ID from ssh_connect
  - remote_path (string): Absolute path on the remote host

Returns:
  JSON with file path and content.

For large files, use ssh_execute with 'head', 'tail', or 'cat | head -c 100000' instead.`,
      inputSchema: {
        session_id: z.string().min(1).describe("Session ID from ssh_connect"),
        remote_path: z
          .string()
          .min(1)
          .describe("Absolute path on the remote host"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const content = await manager.downloadFile(
          params.session_id,
          params.remote_path
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: params.remote_path,
                size_bytes: Buffer.byteLength(content, "utf-8"),
                content,
              }),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Download failed: ${msg}` }],
        };
      }
    }
  );
}
