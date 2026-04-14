import { Client, ConnectConfig, ClientChannel } from "ssh2";
import { randomBytes, createHash } from "crypto";
import { Readable } from "stream";

export interface SSHSession {
  token: string;         // SHA-256 capability token
  ownerKey: string;      // User Key that created this session
  client: Client;
  host: string;
  port: number;
  username: string;
  label?: string;
  createdAt: Date;
  lastUsedAt: Date;
  everUsed: boolean;     // true if ssh_execute/upload/download was called at least once
}

export interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  label?: string;
  ownerKey: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// TTLs
const TTL_UNUSED_MS = 24 * 60 * 60 * 1000;            // 1 day for never-used sessions
const TTL_USED_MS = 90 * 24 * 60 * 60 * 1000;         // 3 months for used sessions
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;             // Check every 5 minutes
const DEFAULT_EXEC_TIMEOUT_MS = 120 * 1000;            // 2 minutes
const MAX_OUTPUT_BYTES = 512 * 1024;                    // 512 KB

function generateSessionToken(): string {
  const raw = randomBytes(32);
  return "sess_" + createHash("sha256").update(raw).digest("hex");
}

export class SSHSessionManager {
  private sessions: Map<string, SSHSession> = new Map(); // keyed by token
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      const ttl = session.everUsed ? TTL_USED_MS : TTL_UNUSED_MS;
      const elapsed = now - session.lastUsedAt.getTime();
      if (elapsed > ttl) {
        console.error(
          `[SSHSessionManager] Session ${token.slice(0, 16)}... expired ` +
          `(${session.everUsed ? "used" : "unused"}, idle ${Math.round(elapsed / 1000)}s)`
        );
        this.forceDisconnect(token);
      }
    }
  }

  // ─── Connect ────────────────────────────────

  async connect(options: ConnectOptions): Promise<SSHSession> {
    const token = generateSessionToken();
    const client = new Client();

    const config: ConnectConfig = {
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 6,
    };

    if (options.privateKey) {
      config.privateKey = options.privateKey;
      if (options.passphrase) config.passphrase = options.passphrase;
    } else if (options.password) {
      config.password = options.password;
    } else {
      throw new Error("Either password or privateKey must be provided");
    }

    return new Promise<SSHSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`Connection to ${options.host}:${options.port ?? 22} timed out after 15s`));
      }, 16000);

      client.on("ready", () => {
        clearTimeout(timeout);
        const session: SSHSession = {
          token,
          ownerKey: options.ownerKey,
          client,
          host: options.host,
          port: options.port ?? 22,
          username: options.username,
          label: options.label,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          everUsed: false,
        };
        this.sessions.set(token, session);
        console.error(
          `[SSHSessionManager] New session ${token.slice(0, 16)}... → ` +
          `${options.username}@${options.host}:${options.port ?? 22}`
        );
        resolve(session);
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      });

      client.on("close", () => {
        if (this.sessions.has(token)) {
          console.error(`[SSHSessionManager] Session ${token.slice(0, 16)}... closed unexpectedly`);
          this.sessions.delete(token);
        }
      });

      client.connect(config);
    });
  }

  // ─── Execute ────────────────────────────────

  async execute(
    token: string,
    command: string,
    timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS
  ): Promise<ExecResult> {
    const session = this.getSessionByToken(token);
    this.markSessionUsed(session);

    return new Promise<ExecResult>((resolve, reject) => {
      const startTime = Date.now();
      let stdoutBuf = "";
      let stderrBuf = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const timer = setTimeout(() => {
        reject(new Error(
          `Command timed out after ${timeoutMs / 1000}s. Increase timeout_ms or split the command.`
        ));
      }, timeoutMs);

      session.client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timer);
          reject(new Error(`Exec failed: ${err.message}`));
          return;
        }

        stream.on("data", (data: Buffer) => {
          if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
            stdoutBuf += data.toString("utf-8");
            if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
              stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES);
              stdoutTruncated = true;
            }
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          if (stderrBuf.length < MAX_OUTPUT_BYTES) {
            stderrBuf += data.toString("utf-8");
            if (stderrBuf.length > MAX_OUTPUT_BYTES) {
              stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES);
              stderrTruncated = true;
            }
          }
        });

        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (stdoutTruncated) stdoutBuf += "\n\n--- OUTPUT TRUNCATED (>512KB) ---";
          if (stderrTruncated) stderrBuf += "\n\n--- STDERR TRUNCATED (>512KB) ---";
          resolve({
            exitCode: code ?? -1,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            durationMs: Date.now() - startTime,
          });
        });
      });
    });
  }

  // ─── File Operations ────────────────────────

  async uploadFile(token: string, content: string, remotePath: string): Promise<void> {
    const session = this.getSessionByToken(token);
    this.markSessionUsed(session);

    return new Promise<void>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) { reject(new Error(`SFTP init failed: ${err.message}`)); return; }
        const ws = sftp.createWriteStream(remotePath);
        ws.on("close", () => { sftp.end(); resolve(); });
        ws.on("error", (e: Error) => { sftp.end(); reject(new Error(`Upload failed: ${e.message}`)); });
        Readable.from([Buffer.from(content, "utf-8")]).pipe(ws);
      });
    });
  }

  async downloadFile(token: string, remotePath: string): Promise<string> {
    const session = this.getSessionByToken(token);
    this.markSessionUsed(session);

    return new Promise<string>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) { reject(new Error(`SFTP init failed: ${err.message}`)); return; }
        let content = "";
        const rs = sftp.createReadStream(remotePath);
        rs.on("data", (data: Buffer) => {
          content += data.toString("utf-8");
          if (content.length > MAX_OUTPUT_BYTES) {
            rs.destroy(); sftp.end();
            reject(new Error("File too large (>512KB). Use ssh_execute with head/tail."));
          }
        });
        rs.on("end", () => { sftp.end(); resolve(content); });
        rs.on("error", (e: Error) => { sftp.end(); reject(new Error(`Download failed: ${e.message}`)); });
      });
    });
  }

  // ─── Disconnect ─────────────────────────────

  /**
   * Disconnect by session token. Returns true if found and disconnected.
   */
  disconnect(token: string): boolean {
    return this.forceDisconnect(token);
  }

  private forceDisconnect(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    try { session.client.end(); } catch { /* ignore */ }
    this.sessions.delete(token);
    console.error(`[SSHSessionManager] Disconnected ${token.slice(0, 16)}...`);
    return true;
  }

  /**
   * Disconnect all sessions owned by a specific User Key.
   * If ownerKey is undefined, disconnect ALL (admin use).
   */
  disconnectByOwner(ownerKey?: string): number {
    let count = 0;
    for (const [token, session] of this.sessions) {
      if (!ownerKey || session.ownerKey === ownerKey) {
        if (this.forceDisconnect(token)) count++;
      }
    }
    return count;
  }

  // ─── List ───────────────────────────────────

  /**
   * List sessions. If ownerKey is provided, filter by owner.
   * If showAll is true (admin), show everything.
   */
  listSessions(ownerKey?: string, showAll?: boolean): Array<{
    session_token: string;
    host: string;
    port: number;
    username: string;
    label?: string;
    createdAt: string;
    lastUsedAt: string;
    everUsed: boolean;
    idleSeconds: number;
    ttlDescription: string;
  }> {
    const now = Date.now();
    return Array.from(this.sessions.values())
      .filter((s) => showAll || (ownerKey && s.ownerKey === ownerKey))
      .map((s) => {
        const idle = Math.round((now - s.lastUsedAt.getTime()) / 1000);
        const ttl = s.everUsed ? TTL_USED_MS : TTL_UNUSED_MS;
        const remainingSec = Math.max(0, Math.round((ttl - (now - s.lastUsedAt.getTime())) / 1000));
        return {
          session_token: s.token,
          host: s.host,
          port: s.port,
          username: s.username,
          ...(s.label ? { label: s.label } : {}),
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          everUsed: s.everUsed,
          idleSeconds: idle,
          ttlDescription: s.everUsed
            ? `${remainingSec}s remaining (3-month TTL)`
            : `${remainingSec}s remaining (1-day TTL, use to extend)`,
        };
      });
  }

  // ─── Helpers ────────────────────────────────

  /**
   * List sessions owned by any of the given keys (union).
   */
  listSessionsByKeys(ownerKeys: string[]): Array<{
    session_token: string;
    host: string;
    port: number;
    username: string;
    label?: string;
    createdAt: string;
    lastUsedAt: string;
    everUsed: boolean;
    idleSeconds: number;
    ttlDescription: string;
  }> {
    const keySet = new Set(ownerKeys);
    const now = Date.now();
    return Array.from(this.sessions.values())
      .filter((s) => keySet.has(s.ownerKey))
      .map((s) => {
        const idle = Math.round((now - s.lastUsedAt.getTime()) / 1000);
        const ttl = s.everUsed ? TTL_USED_MS : TTL_UNUSED_MS;
        const remainingSec = Math.max(0, Math.round((ttl - (now - s.lastUsedAt.getTime())) / 1000));
        return {
          session_token: s.token,
          host: s.host,
          port: s.port,
          username: s.username,
          ...(s.label ? { label: s.label } : {}),
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          everUsed: s.everUsed,
          idleSeconds: idle,
          ttlDescription: s.everUsed
            ? `${remainingSec}s remaining (3-month TTL)`
            : `${remainingSec}s remaining (1-day TTL, use to extend)`,
        };
      });
  }

  getSessionByToken(token: string): SSHSession {
    const session = this.sessions.get(token);
    if (!session) {
      throw new Error(
        `Session token not found or expired. Use ssh_connect to create a new session.`
      );
    }
    return session;
  }

  markSessionUsed(session: SSHSession): void {
    session.lastUsedAt = new Date();
    session.everUsed = true;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.disconnectByOwner(); // disconnect all
  }
}
