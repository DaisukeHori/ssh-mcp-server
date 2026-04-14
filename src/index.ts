import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { SSHSessionManager } from "./services/ssh-session-manager.js";
import { registerSSHTools } from "./tools/ssh-tools.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";

if (REQUIRE_AUTH && !AUTH_TOKEN) {
  console.error(
    "ERROR: AUTH_TOKEN environment variable is required when REQUIRE_AUTH is not 'false'.\n" +
      "Set AUTH_TOKEN=<your-secret> or REQUIRE_AUTH=false for development."
  );
  process.exit(1);
}

// ─────────────────────────────────────────────
// SSH Session Manager (singleton, persists across requests)
// ─────────────────────────────────────────────
const sshManager = new SSHSessionManager();

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!REQUIRE_AUTH) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Authorization header required" });
    return;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token !== AUTH_TOKEN) {
    res.status(403).json({ error: "Invalid bearer token" });
    return;
  }

  next();
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    active_sessions: sshManager.sessionCount,
    uptime_seconds: Math.round(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// MCP Endpoint (Streamable HTTP, stateless per-request)
// ─────────────────────────────────────────────
app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
  try {
    // Create a fresh McpServer and transport per request (stateless pattern)
    const server = new McpServer({
      name: "ssh-mcp-server",
      version: "1.0.0",
    });

    // Register tools with the shared SSH session manager
    registerSSHTools(server, sshManager);

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
// Handle unsupported methods on /mcp
// ─────────────────────────────────────────────
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    error: "Method Not Allowed. Use POST for MCP requests.",
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    error: "Method Not Allowed. Use POST for MCP requests.",
  });
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔══════════════════════════════════════════════════╗
║           SSH MCP Server v1.0.0                  ║
║──────────────────────────────────────────────────║
║  Endpoint:  http://0.0.0.0:${PORT}/mcp${" ".repeat(Math.max(0, 14 - PORT.toString().length))}       ║
║  Health:    http://0.0.0.0:${PORT}/health${" ".repeat(Math.max(0, 11 - PORT.toString().length))}       ║
║  Auth:      ${REQUIRE_AUTH ? "Bearer Token" : "DISABLED (dev mode)"}${" ".repeat(REQUIRE_AUTH ? 7 : 0)}              ║
╚══════════════════════════════════════════════════╝
  `);
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
