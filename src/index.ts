import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { resolve as pathResolve } from "path";
import { execSync } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { SSHSessionManager } from "./services/ssh-session-manager.js";
import { KeyStore } from "./services/key-store.js";
import { CommandRunner } from "./services/command-runner.js";
import { buildCallerContext } from "./services/caller-context.js";
import { registerSSHTools } from "./tools/ssh-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const USER_KEYS_FILE = pathResolve(DATA_DIR, "user-keys.json");

if (!ADMIN_KEY) {
  console.error("ERROR: ADMIN_KEY environment variable is required.");
  process.exit(1);
}

// Singletons
const sshManager = new SSHSessionManager();
const keyStore = new KeyStore(USER_KEYS_FILE, ADMIN_KEY);
const cmdRunner = new CommandRunner();

const app = express();

// Capture raw body for webhook HMAC verification, then parse JSON
app.use(express.json({
  verify: (req: Request, _res, buf) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    sessions: sshManager.sessionCount,
    userKeys: keyStore.userKeyCount,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const keyParam = req.query.key as string | string[] | undefined;
  if (!keyParam) { res.status(401).json({ error: "Missing ?key= parameter" }); return; }

  const ctx = buildCallerContext(keyParam, keyStore);
  if (!ctx) { res.status(403).json({ error: "No valid keys found" }); return; }

  try {
    const server = new McpServer({ name: "ssh-mcp-server", version: "2.1.0" });
    registerSSHTools(server, sshManager, cmdRunner, ctx);
    registerAdminTools(server, keyStore, ctx);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Use POST" }));

// ─────────────────────────────────────────────
// GitHub Webhook → auto-deploy on push
// ─────────────────────────────────────────────
app.post("/webhook/github", (req: Request, res: Response) => {
  // Verify signature if WEBHOOK_SECRET is set
  if (WEBHOOK_SECRET) {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!sig) { res.status(401).json({ error: "Missing signature" }); return; }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) { res.status(400).json({ error: "No body" }); return; }

    const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

    try {
      if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(403).json({ error: "Invalid signature" }); return;
      }
    } catch {
      res.status(403).json({ error: "Invalid signature" }); return;
    }
  }

  // Only respond to push events on main branch
  const event = req.headers["x-github-event"];
  if (event !== "push") {
    res.json({ skipped: true, reason: `event=${event}, only push triggers deploy` });
    return;
  }

  console.error("[Webhook] Push received, starting auto-deploy...");
  res.json({ accepted: true, message: "Deploy started. Server will restart." });

  // Run deploy in background, then exit for systemd restart
  setTimeout(() => {
    try {
      const cwd = "/opt/ssh-mcp-server";
      console.error("[Webhook] git pull...");
      execSync("git pull", { cwd, stdio: "inherit", timeout: 30000 });
      console.error("[Webhook] npm install...");
      execSync("npm install", { cwd, stdio: "inherit", timeout: 120000 });
      console.error("[Webhook] tsc build...");
      execSync("npx tsc", { cwd, stdio: "inherit", timeout: 30000 });
      console.error("[Webhook] Deploy complete. Restarting...");
      process.exit(0); // systemd will restart
    } catch (err) {
      console.error("[Webhook] Deploy FAILED:", err);
      // Don't exit — keep running with old code
    }
  }, 500);
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔═══════════════════════════════════════════════════╗
║         SSH MCP Server v2.1.0                     ║
║───────────────────────────────────────────────────║
║  Endpoint:  http://0.0.0.0:${PORT}/mcp?key=...        ║
║  Multi-key: ?key=ak&key=uk_a&key=uk_b             ║
║  Async:     ssh_execute + ssh_command_status       ║
║  TTL:       1d (unused) / 3mo (used)              ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on("SIGTERM", () => { cmdRunner.destroy(); sshManager.destroy(); process.exit(0); });
process.on("SIGINT", () => { cmdRunner.destroy(); sshManager.destroy(); process.exit(0); });
