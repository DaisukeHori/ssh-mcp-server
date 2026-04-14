import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KeyStore } from "../services/key-store.js";
import { CallerContext } from "./ssh-tools.js";

export function registerAdminTools(
  server: McpServer,
  keyStore: KeyStore,
  caller: CallerContext
): void {

  // ─────────────────────────────────────────────
  // user_key_create (Admin only)
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_create",
    {
      title: "User Key発行",
      description: `[ADMIN ONLY] Create a new User Key. Give this key to a user so they can connect to the MCP server via ?key=xxx.

Args:
  - label (string): Human-readable label (e.g. "hori", "tanaka-dev")

Returns:
  JSON with the full key string. Shown only once — save it.`,
      inputSchema: {
        label: z.string().min(1).max(100).describe("Label for this user key"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false,
        idempotentHint: false, openWorldHint: false,
      },
    },
    async (params) => {
      if (caller.role !== "admin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Permission denied: Admin Key required." }],
        };
      }
      const uk = keyStore.createUserKey(params.label);
      return {
        content: [{ type: "text", text: JSON.stringify({
          key: uk.key,
          label: uk.label,
          createdAt: uk.createdAt,
          message: "⚠️ Save this key now. The full key is shown only once.",
        }, null, 2) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // user_key_list (Admin only)
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_list",
    {
      title: "User Key一覧",
      description: `[ADMIN ONLY] List all User Keys.

Returns:
  JSON array of user keys with key, label, timestamps.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async () => {
      if (caller.role !== "admin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Permission denied: Admin Key required." }],
        };
      }
      const keys = keyStore.listUserKeys();
      return {
        content: [{ type: "text", text: JSON.stringify({
          total: keys.length,
          keys: keys.map((k) => ({
            key: k.key.slice(0, 12) + "..." + k.key.slice(-4),
            key_full: k.key,
            label: k.label,
            createdAt: k.createdAt,
            lastUsedAt: k.lastUsedAt,
          })),
        }, null, 2) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // user_key_delete (Admin only)
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_delete",
    {
      title: "User Key削除",
      description: `[ADMIN ONLY] Delete a User Key. Sessions created by this key will remain active until their TTL expires.

Args:
  - key (string): The full User Key string to delete`,
      inputSchema: {
        key: z.string().min(1).describe("Full User Key string to delete"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async (params) => {
      if (caller.role !== "admin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Permission denied: Admin Key required." }],
        };
      }
      const deleted = keyStore.deleteUserKey(params.key);
      if (deleted) {
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted: true, remaining: keyStore.userKeyCount }) }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: "User Key not found." }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // whoami (all keys)
  // ─────────────────────────────────────────────
  server.registerTool(
    "whoami",
    {
      title: "現在のキー情報",
      description: `Show info about the current API key.

Returns:
  JSON with role, label.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify({
          role: caller.role,
          label: caller.label,
        }, null, 2) }],
      };
    }
  );
}
