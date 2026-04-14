import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHSessionManager } from "../services/ssh-session-manager.js";
import { CommandRunner } from "../services/command-runner.js";
import { CallerContext } from "../services/caller-context.js";

export function registerSSHTools(
  server: McpServer,
  manager: SSHSessionManager,
  cmdRunner: CommandRunner,
  ctx: CallerContext
): void {

  // ─────────────────────────────────────────────
  // ssh_connect (User Key required)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_connect",
    {
      title: "SSH接続",
      description: `[USER KEY REQUIRED] Establish a new SSH connection. Returns a session_token (SHA-256 capability token).

Args:
  - host, port, username, password/private_key/passphrase, label

Returns: session_token. Use it for ssh_execute, ssh_command_status, etc.
TTL: Unused→1day / Used→3months from last use`,
      inputSchema: {
        host: z.string().min(1).describe("Hostname or IP"),
        port: z.number().int().min(1).max(65535).default(22).describe("SSH port"),
        username: z.string().min(1).describe("SSH username"),
        password: z.string().optional().describe("Password"),
        private_key: z.string().optional().describe("Private key (PEM)"),
        passphrase: z.string().optional().describe("Key passphrase"),
        label: z.string().optional().describe("Human-readable label"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      if (!ctx.hasUser || !ctx.primaryUserKey) {
        return { isError: true, content: [{ type: "text", text: "User Key required. Add ?key=uk_xxx or create one via user_key_create." }] };
      }
      try {
        const session = await manager.connect({
          host: params.host, port: params.port, username: params.username,
          password: params.password, privateKey: params.private_key,
          passphrase: params.passphrase, label: params.label,
          ownerKey: ctx.primaryUserKey.key,
        });
        return { content: [{ type: "text", text: JSON.stringify({
          session_token: session.token, host: session.host, port: session.port,
          username: session.username, label: session.label ?? null,
          owned_by: ctx.primaryUserKey.label,
          message: `Connected. Use session_token "${session.token}" for commands.`,
        }, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Connection failed: ${error instanceof Error ? error.message : error}` }] };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_execute (async with wait_ms + tail_lines)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_execute",
    {
      title: "SSHコマンド実行",
      description: `Execute a shell command. Supports async execution for long-running commands.

Behavior:
  - wait_ms omitted or 0: Starts command and returns immediately with command_id (non-blocking)
  - wait_ms > 0: Waits up to that many ms, then returns whatever output exists so far + command_id
  - tail_lines: Limit output to last N lines (useful for large outputs like apt install)

Use ssh_command_status to poll for results later.

Args:
  - session_token (string): From ssh_connect
  - command (string): Shell command(s)
  - wait_ms (number, optional): How long to wait for output (0=return immediately, default: 30000)
  - tail_lines (number, optional): Return only last N lines of stdout/stderr`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token"),
        command: z.string().min(1).max(10000).describe("Shell command"),
        wait_ms: z.number().int().min(0).max(120000).default(30000)
          .describe("Wait time in ms. 0=fire-and-forget. Default 30000 (30s)."),
        tail_lines: z.number().int().min(1).max(10000).optional()
          .describe("Return only last N lines of output"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const session = manager.getSessionByToken(params.session_token);
        manager.markSessionUsed(session);

        const cmd = await cmdRunner.start(session, params.command);

        // Wait for specified time
        if (params.wait_ms > 0) {
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (!cmd.running) { clearInterval(check); resolve(); }
            }, 200);
            setTimeout(() => { clearInterval(check); resolve(); }, params.wait_ms);
          });
        }

        const output = cmdRunner.getOutput(cmd.id, params.tail_lines);
        return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Execution failed: ${error instanceof Error ? error.message : error}` }] };
      }
    }
  );

  // ─────────────────────────────────────────────
  // ssh_command_status (poll for async results)
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_command_status",
    {
      title: "コマンド結果確認",
      description: `Check the status and output of a previously started command.

Use this to poll long-running commands started with ssh_execute.
Returns current stdout/stderr, running status, exit code, and elapsed time.

Args:
  - command_id (string): From ssh_execute result
  - tail_lines (number, optional): Return only last N lines`,
      inputSchema: {
        command_id: z.string().min(1).describe("Command ID from ssh_execute"),
        tail_lines: z.number().int().min(1).max(10000).optional()
          .describe("Return only last N lines of output"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const output = cmdRunner.getOutput(params.command_id, params.tail_lines);
      if (!output) {
        return { isError: true, content: [{ type: "text", text: `Command ${params.command_id} not found. Commands are retained for 1 hour after completion.` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_disconnect
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_disconnect",
    {
      title: "SSH切断",
      description: `Disconnect an SSH session by its token.`,
      inputSchema: { session_token: z.string().min(1).describe("Session token") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const success = manager.disconnect(params.session_token);
      if (success) return { content: [{ type: "text", text: JSON.stringify({ disconnected: true }) }] };
      return { isError: true, content: [{ type: "text", text: "Session not found or already disconnected." }] };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_list_sessions
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_list_sessions",
    {
      title: "SSHセッション一覧",
      description: `List SSH sessions. Admin sees all. User sees own sessions only. Multi-key: union of all User Keys' sessions.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      let sessions;
      if (ctx.hasAdmin) {
        sessions = manager.listSessions(undefined, true);
      } else {
        sessions = manager.listSessionsByKeys(ctx.userKeyStrings);
      }
      // Attach running commands count per session
      const enriched = sessions.map((s) => ({
        ...s,
        running_commands: cmdRunner.listBySession(s.session_token).filter((c) => c.running).length,
      }));
      return { content: [{ type: "text", text: JSON.stringify({
        total: enriched.length,
        scope: ctx.hasAdmin ? "all (admin)" : `${ctx.userKeys.length} user key(s)`,
        sessions: enriched,
      }, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // ssh_upload_file
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_upload_file",
    {
      title: "SSHファイルアップロード",
      description: `Upload text content to remote host via SFTP. Max ~1MB.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token"),
        content: z.string().max(1048576).describe("File content"),
        remote_path: z.string().min(1).describe("Remote absolute path"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const session = manager.getSessionByToken(params.session_token);
        manager.markSessionUsed(session);
        await manager.uploadFile(params.session_token, params.content, params.remote_path);
        return { content: [{ type: "text", text: JSON.stringify({
          uploaded: params.remote_path, size_bytes: Buffer.byteLength(params.content, "utf-8"),
        }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Upload failed: ${error instanceof Error ? error.message : error}` }] };
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
      description: `Download a text file from remote host via SFTP. Max 512KB.
For large files, use ssh_execute with head/tail.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token"),
        remote_path: z.string().min(1).describe("Remote absolute path"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const session = manager.getSessionByToken(params.session_token);
        manager.markSessionUsed(session);
        const content = await manager.downloadFile(params.session_token, params.remote_path);
        return { content: [{ type: "text", text: JSON.stringify({
          path: params.remote_path, size_bytes: Buffer.byteLength(content, "utf-8"), content,
        }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Download failed: ${error instanceof Error ? error.message : error}` }] };
      }
    }
  );
}
