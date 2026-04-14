import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHSessionManager } from "../services/ssh-session-manager.js";
import { KeyRole } from "../services/key-store.js";

export interface CallerContext {
  role: KeyRole;
  key: string;
  label: string;
}

export function registerSSHTools(
  server: McpServer,
  manager: SSHSessionManager,
  caller: CallerContext
): void {

  // ─────────────────────────────────────────────
  // ssh_connect (User Key only)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_connect",
    {
      title: "SSH接続",
      description: `[USER KEY ONLY] Establish a new SSH connection. Returns a session_token (SHA-256 capability token) that can be shared with others.

Args:
  - host (string): Hostname or IP (e.g. "192.168.70.226")
  - port (number, optional): SSH port (default: 22)
  - username (string): SSH username
  - password (string, optional): Password auth
  - private_key (string, optional): Private key (PEM)
  - passphrase (string, optional): Key passphrase
  - label (string, optional): Human-readable label

Returns:
  JSON with session_token. Use this token for all subsequent operations.
  The token is a SHA-256 hash — safe to share, cannot reveal SSH credentials.

TTL:
  - Unused sessions expire after 1 day
  - Once you run ssh_execute/upload/download, TTL extends to 3 months from last use`,
      inputSchema: {
        host: z.string().min(1).describe("Hostname or IP address"),
        port: z.number().int().min(1).max(65535).default(22).describe("SSH port"),
        username: z.string().min(1).describe("SSH username"),
        password: z.string().optional().describe("Password"),
        private_key: z.string().optional().describe("Private key (PEM format)"),
        passphrase: z.string().optional().describe("Key passphrase"),
        label: z.string().optional().describe("Human-readable label"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async (params) => {
      if (caller.role !== "user") {
        return {
          isError: true,
          content: [{ type: "text", text: "Only User Keys can create SSH sessions. Use a User Key or create one with user_key_create." }],
        };
      }
      try {
        const session = await manager.connect({
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.password,
          privateKey: params.private_key,
          passphrase: params.passphrase,
          label: params.label,
          ownerKey: caller.key,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            session_token: session.token,
            host: session.host,
            port: session.port,
            username: session.username,
            label: session.label ?? null,
            message: `Connected. Use session_token "${session.token}" for ssh_execute etc.`,
          }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Connection failed: ${msg}` }] };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_execute (capability: anyone with session_token)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_execute",
    {
      title: "SSHコマンド実行",
      description: `Execute a shell command on an SSH session. Anyone with the session_token can use this.

Args:
  - session_token (string): Token from ssh_connect
  - command (string): Shell command(s). Use && or ; for multiple.
  - timeout_ms (number, optional): Timeout (default: 120000ms, max: 600000ms)

Returns:
  JSON with exit_code, stdout, stderr, duration_ms.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token from ssh_connect"),
        command: z.string().min(1).max(10000).describe("Shell command"),
        timeout_ms: z.number().int().min(1000).max(600000).default(120000).describe("Timeout in ms"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const result = await manager.execute(params.session_token, params.command, params.timeout_ms);
        return {
          content: [{ type: "text", text: JSON.stringify({
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.durationMs,
            success: result.exitCode === 0,
          }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Execution failed: ${msg}` }] };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_disconnect (capability: anyone with session_token)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_disconnect",
    {
      title: "SSH切断",
      description: `Disconnect an SSH session by its token.

Args:
  - session_token (string): Session token to disconnect`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token to disconnect"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async (params) => {
      const success = manager.disconnect(params.session_token);
      if (success) {
        return { content: [{ type: "text", text: JSON.stringify({ disconnected: true }) }] };
      }
      return { isError: true, content: [{ type: "text", text: "Session token not found or already disconnected." }] };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_list_sessions
  //   User Key → own sessions only
  //   Admin Key → all sessions
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_list_sessions",
    {
      title: "SSHセッション一覧",
      description: `List SSH sessions. User Keys see only their own sessions. Admin Keys see all sessions.

Returns:
  JSON array of sessions with token, host, username, TTL info.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async () => {
      const isAdmin = caller.role === "admin";
      const sessions = manager.listSessions(
        isAdmin ? undefined : caller.key,
        isAdmin
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ total: sessions.length, sessions }, null, 2) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_upload_file (capability: anyone with session_token)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_upload_file",
    {
      title: "SSHファイルアップロード",
      description: `Upload text content to the remote host via SFTP.

Args:
  - session_token (string): Session token
  - content (string): File content (text, max ~1MB)
  - remote_path (string): Absolute path on remote host`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token"),
        content: z.string().max(1048576).describe("File content"),
        remote_path: z.string().min(1).describe("Remote path"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: true, openWorldHint: true,
      },
    },
    async (params) => {
      try {
        await manager.uploadFile(params.session_token, params.content, params.remote_path);
        return {
          content: [{ type: "text", text: JSON.stringify({
            uploaded: params.remote_path,
            size_bytes: Buffer.byteLength(params.content, "utf-8"),
          }) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Upload failed: ${msg}` }] };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_download_file (capability: anyone with session_token)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_download_file",
    {
      title: "SSHファイルダウンロード",
      description: `Download a text file from the remote host via SFTP. Max 512KB.

Args:
  - session_token (string): Session token
  - remote_path (string): Absolute path on remote host`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token"),
        remote_path: z.string().min(1).describe("Remote path"),
      },
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const content = await manager.downloadFile(params.session_token, params.remote_path);
        return {
          content: [{ type: "text", text: JSON.stringify({
            path: params.remote_path,
            size_bytes: Buffer.byteLength(content, "utf-8"),
            content,
          }) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Download failed: ${msg}` }] };
      }
    }
  );
}
