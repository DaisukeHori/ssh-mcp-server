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
  // ssh_connect
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_connect",
    {
      title: "SSH接続",
      description: `[USER KEY REQUIRED] Establish a persistent SSH connection to a remote host.

WHAT IT RETURNS:
  A session_token (e.g. "sess_a3f8b2c1...") — a SHA-256 capability token.
  This token is your key to operate this SSH session in all subsequent tool calls.
  SAVE THIS TOKEN — it persists across conversation messages.

WORKFLOW:
  1. Call ssh_connect with host/username/password → get session_token
  2. Use session_token in ssh_execute, ssh_upload_file, ssh_download_file
  3. The session stays alive for 3 months (from last use) or 1 day (if never used)
  4. Call ssh_disconnect when done, or let it auto-expire

SESSION LIFECYCLE:
  - Created but unused (no ssh_execute/upload/download yet): expires after 1 DAY
  - Used at least once: expires after 3 MONTHS from last use
  - Server restart: ALL sessions are lost (reconnect needed)

SHARING:
  session_token can be shared with other users/conversations.
  Anyone with the token can execute commands on that session.

MULTIPLE CONNECTIONS:
  You can call ssh_connect multiple times to different hosts.
  Each returns a unique session_token. Manage them independently.

EXAMPLES:
  - Connect to server: host="192.168.1.100", username="root", password="secret"
  - Connect with label: host="10.0.0.5", username="deploy", password="xxx", label="web-server"
  - Connect with key: host="10.0.0.5", username="deploy", private_key="-----BEGIN OPENSSH PRIVATE KEY-----..."

ERRORS:
  - "User Key required" → You need a User Key in ?key= URL param
  - "Connection blocked" → That host is in the server's BLOCKED_HOSTS list
  - "SSH connection failed" → Wrong host/port/credentials, or host unreachable`,
      inputSchema: {
        host: z.string().min(1).describe("Hostname or IP address of the SSH server"),
        port: z.number().int().min(1).max(65535).default(22).describe("SSH port number (default: 22)"),
        username: z.string().min(1).describe("SSH username (e.g. 'root', 'ubuntu', 'deploy')"),
        password: z.string().optional().describe("Password for password-based authentication"),
        private_key: z.string().optional().describe("Full private key content in PEM format (-----BEGIN OPENSSH PRIVATE KEY-----...)"),
        passphrase: z.string().optional().describe("Passphrase to decrypt an encrypted private key"),
        label: z.string().optional().describe("Human-readable label for this session (e.g. 'proxmox-host', 'web-server'). Shown in ssh_list_sessions."),
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
  // ssh_execute
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_execute",
    {
      title: "SSHコマンド実行",
      description: `Execute a shell command on a connected SSH session. Supports both synchronous and asynchronous execution.

IMPORTANT — CHOOSE THE RIGHT PATTERN:

  Pattern 1: SHORT COMMANDS (ls, cat, uptime, hostname, systemctl status, etc.)
    → Use default wait_ms=30000 (30 seconds). Command usually finishes within this time.
    → Check "running": false and "exit_code": 0 in the response to confirm completion.

  Pattern 2: LONG COMMANDS (apt install, npm install, git clone, builds, large downloads)
    → Set wait_ms=5000 to 10000 (5-10 seconds) to get early output.
    → The response will include a "command_id" (e.g. "cmd_0001").
    → If "running": true, the command is still executing in the background.
    → Use ssh_command_status(command_id="cmd_0001") to poll for completion.
    → You can poll multiple times until "running": false.
    → Use tail_lines=20 to 50 to limit output and avoid flooding the context.

  Pattern 3: FIRE-AND-FORGET (background tasks, nohup, detached processes)
    → Set wait_ms=0. Returns immediately with command_id.
    → Poll later with ssh_command_status if you need the result.

RETURN VALUE:
  {
    "command_id": "cmd_0001",     ← Use this with ssh_command_status to poll
    "command": "apt install ...",  ← The command that was run
    "running": true/false,         ← true = still executing, false = finished
    "exit_code": 0/1/null,         ← null if still running, 0 = success, non-0 = error
    "stdout": "...",               ← Standard output (may be partial if still running)
    "stderr": "...",               ← Standard error
    "elapsed_ms": 5032,            ← Time elapsed since command started
    "stdout_lines": 142,           ← Total line count (useful to decide tail_lines)
    "stderr_lines": 3
  }

HOW TO HANDLE THE RESPONSE:
  1. Check "running" field first
  2. If running=false and exit_code=0 → command succeeded, show stdout to user
  3. If running=false and exit_code!=0 → command failed, show stderr to user
  4. If running=true → command still executing, tell user and offer to poll with ssh_command_status

MULTIPLE COMMANDS:
  Join with && (stop on first failure) or ; (run all regardless).
  Example: "cd /opt/app && git pull && npm install && npm run build"

SHELL CONTEXT:
  Each ssh_execute runs in a NEW shell. cd does NOT persist between calls.
  To run in a specific directory: "cd /opt/app && your_command"

OUTPUT LIMITS:
  - stdout/stderr buffer: 2MB max per command
  - Use tail_lines to limit what's returned in the response
  - For very large outputs, use tail_lines=30 to 100

TIMEOUT:
  wait_ms is NOT a hard timeout that kills the command.
  It only controls how long THIS tool call waits before returning.
  The command continues running in the background regardless.
  Maximum wait_ms is 120000 (2 minutes).`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token from ssh_connect. This identifies which SSH connection to use."),
        command: z.string().min(1).max(10000).describe("Shell command to execute. Use && to chain commands. Use ; to run all regardless of failures. Each call runs in a fresh shell context."),
        wait_ms: z.number().int().min(0).max(120000).default(30000)
          .describe("How many milliseconds to wait for output before returning. Default: 30000 (30s, good for short commands). Set 5000-10000 for long commands like apt/npm install. Set 0 for fire-and-forget. The command continues running in background regardless."),
        tail_lines: z.number().int().min(1).max(10000).optional()
          .describe("Return only the last N lines of stdout/stderr. Use 20-50 for long-running commands with lots of output (e.g. apt install). Omit for short commands."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const session = manager.getSessionByToken(params.session_token);
        manager.markSessionUsed(session);

        const cmd = await cmdRunner.start(session, params.command);

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
  // ssh_command_status
  // ─────────────────────────────────────────────
  server.registerTool(
    "ssh_command_status",
    {
      title: "コマンド結果確認",
      description: `Poll the current status and output of a previously started command.

WHEN TO USE:
  After ssh_execute returns with "running": true, use this tool to check if the command has finished.
  This is the companion tool for async/long-running command execution.

TYPICAL WORKFLOW:
  1. ssh_execute(command="apt install -y nodejs", wait_ms=5000) → running: true, command_id: "cmd_0001"
  2. ssh_command_status(command_id="cmd_0001", tail_lines=30) → running: true (still installing)
  3. ssh_command_status(command_id="cmd_0001", tail_lines=30) → running: false, exit_code: 0 (done!)

RETURN VALUE:
  Same format as ssh_execute response:
  {
    "command_id": "cmd_0001",
    "running": true/false,
    "exit_code": 0/1/null,
    "stdout": "...",
    "stderr": "...",
    "elapsed_ms": 34521,
    "stdout_lines": 142,
    "stderr_lines": 3
  }

TIPS:
  - Use tail_lines=20 to 50 to avoid flooding context with huge output
  - Check stdout_lines to see total output size
  - Commands are retained for 1 HOUR after completion, then cleaned up
  - If command_id is not found, it either never existed or was cleaned up

POLLING STRATEGY:
  - Wait a reasonable time before first poll (e.g. tell user "installing, will check in a moment")
  - For apt/npm install: poll every 15-30 seconds
  - For builds: poll every 10-20 seconds
  - Don't poll in a tight loop`,
      inputSchema: {
        command_id: z.string().min(1).describe("Command ID from ssh_execute result (e.g. 'cmd_0001'). Each ssh_execute call returns a unique command_id."),
        tail_lines: z.number().int().min(1).max(10000).optional()
          .describe("Return only the last N lines of output. Recommended: 20-50 for large outputs."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const output = cmdRunner.getOutput(params.command_id, params.tail_lines);
      if (!output) {
        return { isError: true, content: [{ type: "text", text: `Command ${params.command_id} not found. Commands are retained for 1 hour after completion. It may have been cleaned up or never existed.` }] };
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
      description: `Explicitly disconnect an SSH session and free its resources.

WHEN TO USE:
  - When you're done with a server and want to clean up
  - When the user asks to disconnect
  - Usually NOT necessary — sessions auto-expire (1 day unused / 3 months used)

AFTER DISCONNECT:
  - The session_token becomes invalid
  - Any running commands on this session are terminated
  - The session disappears from ssh_list_sessions

NOTE: If the session_token is not found, it was already disconnected or expired.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token to disconnect. Get this from ssh_connect or ssh_list_sessions."),
      },
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
      description: `List all active SSH sessions visible to the current API key(s).

VISIBILITY RULES:
  - Admin Key present: shows ALL sessions from all users
  - User Key(s) only: shows sessions created by any of the provided User Keys
  - Multiple User Keys: shows the union (combined) of all their sessions

RETURN VALUE:
  Each session includes:
  - session_token: the token needed for ssh_execute etc.
  - host, port, username, label
  - createdAt, lastUsedAt, idleSeconds
  - everUsed: whether ssh_execute/upload/download was called at least once
  - ttlDescription: when this session will expire
  - running_commands: number of currently running commands

USE CASES:
  - Reconnect to a previous session (find the session_token)
  - Check which servers are connected
  - Monitor idle sessions before they expire
  - Check if long-running commands are still active (running_commands > 0)`,
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
      description: `Upload text content as a file to the remote host via SFTP.

USE CASES:
  - Write config files (nginx.conf, systemd service files, .env files)
  - Upload scripts (deploy.sh, setup.sh)
  - Write code files to the remote server
  - Create/overwrite any text file

LIMITS:
  - Maximum content size: ~1MB
  - Text content only (no binary files)
  - The file is created/overwritten at the specified path
  - Parent directories must exist (use ssh_execute "mkdir -p /path/to/dir" first if needed)

EXAMPLES:
  - Upload nginx config: content="server { listen 80; ... }", remote_path="/etc/nginx/conf.d/app.conf"
  - Upload script: content="#!/bin/bash\\necho hello", remote_path="/tmp/test.sh"
  - After upload, you may need: ssh_execute("chmod +x /tmp/test.sh") to make it executable

TIP: For large files or binary files, use ssh_execute with curl/wget to download them instead.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token from ssh_connect"),
        content: z.string().max(1048576).describe("File content to write (text only, max ~1MB)"),
        remote_path: z.string().min(1).describe("Absolute file path on remote host (e.g. '/etc/nginx/nginx.conf', '/tmp/script.sh')"),
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
      description: `Download a text file from the remote host via SFTP.

USE CASES:
  - Read config files, log files, code files
  - Check file contents before editing

LIMITS:
  - Maximum file size: 512KB
  - Text files only
  - If file is larger than 512KB, use ssh_execute with:
    "head -100 /path/to/file"  (first 100 lines)
    "tail -100 /path/to/file"  (last 100 lines)
    "cat /path/to/file | head -c 100000"  (first 100KB)

TIP: For log files that are constantly growing, ssh_execute with "tail -50 /var/log/xxx" is better.`,
      inputSchema: {
        session_token: z.string().min(1).describe("Session token from ssh_connect"),
        remote_path: z.string().min(1).describe("Absolute file path on remote host (e.g. '/etc/nginx/nginx.conf', '/var/log/syslog')"),
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
