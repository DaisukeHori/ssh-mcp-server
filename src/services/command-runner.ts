import { ClientChannel } from "ssh2";
import { SSHSession } from "./ssh-session-manager.js";

export interface RunningCommand {
  id: string;
  sessionToken: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  running: boolean;
  startedAt: Date;
  finishedAt: Date | null;
}

const MAX_BUFFER = 2 * 1024 * 1024; // 2MB per command buffer
const COMMAND_RETAIN_MS = 60 * 60 * 1000; // Keep finished commands for 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class CommandRunner {
  private commands: Map<string, RunningCommand> = new Map();
  private counter = 0;
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  private nextId(): string {
    this.counter++;
    return `cmd_${this.counter.toString().padStart(4, "0")}`;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, cmd] of this.commands) {
      if (!cmd.running && cmd.finishedAt && now - cmd.finishedAt.getTime() > COMMAND_RETAIN_MS) {
        this.commands.delete(id);
      }
    }
  }

  /**
   * Start a command. Returns immediately with the command ID.
   * Output is buffered in memory as the command runs.
   */
  start(session: SSHSession, command: string): Promise<RunningCommand> {
    const id = this.nextId();
    const cmd: RunningCommand = {
      id,
      sessionToken: session.token,
      command,
      stdout: "",
      stderr: "",
      exitCode: null,
      running: true,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.commands.set(id, cmd);

    return new Promise((resolve, reject) => {
      session.client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          cmd.running = false;
          cmd.exitCode = -1;
          cmd.stderr = `Exec failed: ${err.message}`;
          cmd.finishedAt = new Date();
          // Still resolve - caller gets the error in the command object
          resolve(cmd);
          return;
        }

        stream.on("data", (data: Buffer) => {
          if (cmd.stdout.length < MAX_BUFFER) {
            cmd.stdout += data.toString("utf-8");
            if (cmd.stdout.length > MAX_BUFFER) {
              cmd.stdout = cmd.stdout.slice(0, MAX_BUFFER);
            }
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          if (cmd.stderr.length < MAX_BUFFER) {
            cmd.stderr += data.toString("utf-8");
            if (cmd.stderr.length > MAX_BUFFER) {
              cmd.stderr = cmd.stderr.slice(0, MAX_BUFFER);
            }
          }
        });

        stream.on("close", (code: number | null) => {
          cmd.exitCode = code ?? -1;
          cmd.running = false;
          cmd.finishedAt = new Date();
        });

        // Resolve immediately - command is now running in background
        resolve(cmd);
      });
    });
  }

  /**
   * Get a command by ID.
   */
  get(commandId: string): RunningCommand | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Get output with optional line limiting.
   */
  getOutput(commandId: string, tailLines?: number): {
    command_id: string;
    command: string;
    running: boolean;
    exit_code: number | null;
    started_at: string;
    finished_at: string | null;
    elapsed_ms: number;
    stdout: string;
    stderr: string;
    stdout_lines: number;
    stderr_lines: number;
  } | null {
    const cmd = this.commands.get(commandId);
    if (!cmd) return null;

    let stdout = cmd.stdout;
    let stderr = cmd.stderr;

    const stdoutTotalLines = stdout.split("\n").length;
    const stderrTotalLines = stderr.split("\n").length;

    if (tailLines && tailLines > 0) {
      stdout = stdout.split("\n").slice(-tailLines).join("\n");
      stderr = stderr.split("\n").slice(-tailLines).join("\n");
    }

    const now = Date.now();
    const elapsed = cmd.finishedAt
      ? cmd.finishedAt.getTime() - cmd.startedAt.getTime()
      : now - cmd.startedAt.getTime();

    return {
      command_id: cmd.id,
      command: cmd.command,
      running: cmd.running,
      exit_code: cmd.exitCode,
      started_at: cmd.startedAt.toISOString(),
      finished_at: cmd.finishedAt?.toISOString() ?? null,
      elapsed_ms: elapsed,
      stdout,
      stderr,
      stdout_lines: stdoutTotalLines,
      stderr_lines: stderrTotalLines,
    };
  }

  /**
   * List commands for a session token.
   */
  listBySession(sessionToken: string): Array<{
    command_id: string;
    command: string;
    running: boolean;
    exit_code: number | null;
    elapsed_ms: number;
    stdout_lines: number;
  }> {
    const now = Date.now();
    const results: Array<{
      command_id: string;
      command: string;
      running: boolean;
      exit_code: number | null;
      elapsed_ms: number;
      stdout_lines: number;
    }> = [];
    for (const cmd of this.commands.values()) {
      if (cmd.sessionToken === sessionToken) {
        const elapsed = cmd.finishedAt
          ? cmd.finishedAt.getTime() - cmd.startedAt.getTime()
          : now - cmd.startedAt.getTime();
        results.push({
          command_id: cmd.id,
          command: cmd.command.length > 80 ? cmd.command.slice(0, 80) + "..." : cmd.command,
          running: cmd.running,
          exit_code: cmd.exitCode,
          elapsed_ms: elapsed,
          stdout_lines: cmd.stdout.split("\n").length,
        });
      }
    }
    return results;
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.commands.clear();
  }
}
