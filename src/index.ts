import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { resolve as pathResolve } from "path";
import { SSHSessionManager } from "./services/ssh-session-manager.js";
import { KeyStore } from "./services/key-store.js";
import { registerSSHTools } from "./tools/ssh-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const USER_KEYS_FILE = pathResolve(DATA_DIR, "user-keys.json");

if (!ADMIN_KEY) {
  console.error("ERROR: ADMIN_KEY environment variable is required.");
  console.error("  export ADMIN_KEY=$(openssl rand -hex 32)");
  process.exit(1);
}

// ─────────────────────────────────────────────
// Singletons
// ─────────────────────────────────────────────
const sshManager = new SSHSessionManager();
const keyStore = new KeyStore(USER_KEYS_FILE, ADMIN_KEY);

// ─────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// Health (no auth)
// ─────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    sessions: sshManager.sessionCount,
    userKeys: keyStore.userKeyCount,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// MCP Endpoint — auth via ?key= URL parameter
// ─────────────────────────────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  // Resolve key from URL parameter
  const keyParam = req.query.key;
  if (!keyParam || typeof keyParam !== "string") {
    res.status(401).json({ error: "Missing ?key= parameter" });
    return;
  }

  const resolved = keyStore.resolve(keyParam);
  if (!resolved) {
    res.status(403).json({ error: "Invalid key" });
    return;
  }

  try {
    const server = new McpServer({
      name: "ssh-mcp-server",
      version: "2.0.0",
    });

    // Register tools scoped to caller
    registerSSHTools(server, sshManager, resolved);
    registerAdminTools(server, keyStore, resolved);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Use POST" });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Use POST" });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔═══════════════════════════════════════════════╗
║         SSH MCP Server v2.0.0                 ║
║───────────────────────────────────────────────║
║  Endpoint:   http://0.0.0.0:${PORT}/mcp?key=...   ║
║  Health:     http://0.0.0.0:${PORT}/health         ║
║  Admin Key:  ${ADMIN_KEY.slice(0, 8)}...${ADMIN_KEY.slice(-4)}                     ║
║  User Keys:  ${keyStore.userKeyCount} loaded                       ║
║  TTL:        1d (unused) / 3mo (used)         ║
╚═══════════════════════════════════════════════╝
  `);
});

// ─────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────
process.on("SIGTERM", () => { sshManager.destroy(); process.exit(0); });
process.on("SIGINT", () => { sshManager.destroy(); process.exit(0); });
