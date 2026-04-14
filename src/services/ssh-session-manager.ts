import { Client, ConnectConfig, ClientChannel } from "ssh2";
import { Readable } from "stream";

export interface SSHSession {
  id: string;
  client: Client;
  host: string;
  port: number;
  username: string;
  connectedAt: Date;
  lastUsedAt: Date;
  label?: string;
}

export interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  label?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute
const DEFAULT_EXEC_TIMEOUT_MS = 120 * 1000; // 2 minutes
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB max output

export class SSHSessionManager {
  private sessions: Map<string, SSHSession> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private sessionCounter = 0;

  constructor() {
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt.getTime() > SESSION_TTL_MS) {
        console.error(`[SSHSessionManager] Session ${id} expired (idle ${Math.round((now - session.lastUsedAt.getTime()) / 1000)}s), disconnecting`);
        this.disconnect(id);
      }
    }
  }

  private generateSessionId(): string {
    this.sessionCounter++;
    const ts = Date.now().toString(36);
    const seq = this.sessionCounter.toString(36).padStart(3, "0");
    return `ssh-${ts}-${seq}`;
  }

  async connect(options: ConnectOptions): Promise<SSHSession> {
    const sessionId = this.generateSessionId();
    const client = new Client();

    const config: ConnectConfig = {
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };

    if (options.privateKey) {
      config.privateKey = options.privateKey;
      if (options.passphrase) {
        config.passphrase = options.passphrase;
      }
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
          id: sessionId,
          client,
          host: options.host,
          port: options.port ?? 22,
          username: options.username,
          connectedAt: new Date(),
          lastUsedAt: new Date(),
          label: options.label,
        };
        this.sessions.set(sessionId, session);
        console.error(`[SSHSessionManager] Session ${sessionId} connected to ${options.username}@${options.host}:${options.port ?? 22}`);
        resolve(session);
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      });

      client.on("close", () => {
        if (this.sessions.has(sessionId)) {
          console.error(`[SSHSessionManager] Session ${sessionId} closed unexpectedly`);
          this.sessions.delete(sessionId);
        }
      });

      client.connect(config);
    });
  }

  async execute(
    sessionId: string,
    command: string,
    timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS
  ): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found. Use ssh_list_sessions to see active sessions, or ssh_connect to create a new one.`);
    }

    session.lastUsedAt = new Date();

    return new Promise<ExecResult>((resolve, reject) => {
      const startTime = Date.now();
      let stdoutBuf = "";
      let stderrBuf = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const timer = setTimeout(() => {
        reject(
          new Error(
            `Command timed out after ${timeoutMs / 1000}s. Consider increasing timeout or breaking the command into smaller parts.`
          )
        );
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
          const durationMs = Date.now() - startTime;

          if (stdoutTruncated) {
            stdoutBuf += "\n\n--- OUTPUT TRUNCATED (exceeded 512KB) ---";
          }
          if (stderrTruncated) {
            stderrBuf += "\n\n--- STDERR TRUNCATED (exceeded 512KB) ---";
          }

          resolve({
            exitCode: code ?? -1,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            durationMs,
          });
        });
      });
    });
  }

  async uploadFile(
    sessionId: string,
    localContent: string,
    remotePath: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }

    session.lastUsedAt = new Date();

    return new Promise<void>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP init failed: ${err.message}`));
          return;
        }

        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on("close", () => {
          sftp.end();
          resolve();
        });
        writeStream.on("error", (writeErr: Error) => {
          sftp.end();
          reject(new Error(`File upload failed: ${writeErr.message}`));
        });

        const readable = Readable.from([Buffer.from(localContent, "utf-8")]);
        readable.pipe(writeStream);
      });
    });
  }

  async downloadFile(
    sessionId: string,
    remotePath: string
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }

    session.lastUsedAt = new Date();

    return new Promise<string>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP init failed: ${err.message}`));
          return;
        }

        let content = "";
        const readStream = sftp.createReadStream(remotePath);

        readStream.on("data", (data: Buffer) => {
          content += data.toString("utf-8");
          if (content.length > MAX_OUTPUT_BYTES) {
            readStream.destroy();
            sftp.end();
            reject(
              new Error(
                `File too large (>512KB). Use ssh_execute with 'head' or 'tail' to read portions.`
              )
            );
          }
        });

        readStream.on("end", () => {
          sftp.end();
          resolve(content);
        });

        readStream.on("error", (readErr: Error) => {
          sftp.end();
          reject(new Error(`File download failed: ${readErr.message}`));
        });
      });
    });
  }

  disconnect(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      session.client.end();
    } catch {
      // Ignore errors on disconnect
    }
    this.sessions.delete(sessionId);
    console.error(`[SSHSessionManager] Session ${sessionId} disconnected`);
    return true;
  }

  disconnectAll(): number {
    let count = 0;
    for (const [id] of this.sessions) {
      if (this.disconnect(id)) {
        count++;
      }
    }
    return count;
  }

  listSessions(): Array<{
    id: string;
    host: string;
    port: number;
    username: string;
    connectedAt: string;
    lastUsedAt: string;
    idleSeconds: number;
    label?: string;
  }> {
    const now = Date.now();
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      host: s.host,
      port: s.port,
      username: s.username,
      connectedAt: s.connectedAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      idleSeconds: Math.round((now - s.lastUsedAt.getTime()) / 1000),
      ...(s.label ? { label: s.label } : {}),
    }));
  }

  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.disconnectAll();
  }
}
