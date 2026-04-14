import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { resolve as pathResolve } from "path";
import { SSHSessionManager } from "./services/ssh-session-manager.js";
import { TokenStore, APIToken } from "./services/token-store.js";
import { registerSSHTools, CallerContext } from "./tools/ssh-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const TOKEN_FILE = pathResolve(DATA_DIR, "tokens.json");

// ─────────────────────────────────────────────
// Singletons (persist across HTTP requests)
// ─────────────────────────────────────────────
const sshManager = new SSHSessionManager();
const tokenStore = new TokenStore(TOKEN_FILE);

// Bootstrap: create initial admin token if none exist
const initialToken = tokenStore.ensureAdminToken();

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// Auth Middleware - resolves Bearer token to CallerContext
// ─────────────────────────────────────────────
interface AuthenticatedRequest extends Request {
  callerContext?: CallerContext;
  apiToken?: APIToken;
}

function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({
      error: "Authorization header required. Use: Authorization: Bearer <token>",
    });
    return;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    res.status(401).json({ error: "Invalid authorization format. Use: Bearer <token>" });
    return;
  }

  const tokenString = parts[1]!;
  const apiToken = tokenStore.validate(tokenString);

  if (!apiToken) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }

  req.callerContext = {
    tokenId: apiToken.id,
    isAdmin: apiToken.isAdmin,
    label: apiToken.label,
  };
  req.apiToken = apiToken;

  next();
}

// ─────────────────────────────────────────────
// Health check (no auth required)
// ─────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    active_sessions: sshManager.sessionCount,
    active_tokens: tokenStore.tokenCount,
    uptime_seconds: Math.round(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// MCP Endpoint (Streamable HTTP, stateless per-request)
// ─────────────────────────────────────────────
app.post("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const caller = req.callerContext!;

    // Create a fresh McpServer per request (stateless)
    const server = new McpServer({
      name: "ssh-mcp-server",
      version: "1.0.0",
    });

    // Register tools scoped to this caller
    registerSSHTools(server, sshManager, caller);
    registerAdminTools(server, tokenStore, caller);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Request handling error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ─────────────────────────────────────────────
// Unsupported methods on /mcp
// ─────────────────────────────────────────────
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST." });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST." });
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔══════════════════════════════════════════════════════╗
║           SSH MCP Server v1.0.0                      ║
║──────────────────────────────────────────────────────║
║  Endpoint:    http://0.0.0.0:${PORT}/mcp                  ║
║  Health:      http://0.0.0.0:${PORT}/health               ║
║  Token file:  ${TOKEN_FILE}
║  Auth:        Multi-token (Bearer)                   ║
║  Tokens:      ${tokenStore.tokenCount} active                            ║
╚══════════════════════════════════════════════════════╝
  `);

  if (initialToken) {
    console.error(`
┌──────────────────────────────────────────────────────┐
│  ⚠️  INITIAL ADMIN TOKEN (save this now!)            │
│                                                      │
│  ${initialToken}
│                                                      │
│  This will NOT be shown again.                       │
└──────────────────────────────────────────────────────┘
    `);
  }
});

// ─────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────
function shutdown(signal: string): void {
  console.error(`\n[Server] ${signal} received, shutting down...`);
  sshManager.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
