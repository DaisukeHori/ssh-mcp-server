import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KeyStore } from "../services/key-store.js";
import { CallerContext } from "../services/caller-context.js";

export function registerAdminTools(
  server: McpServer,
  keyStore: KeyStore,
  ctx: CallerContext
): void {

  // ─────────────────────────────────────────────
  // user_key_create (Admin only)
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_create",
    {
      title: "User Key発行",
      description: `[ADMIN KEY REQUIRED] Create a new User Key.

Args:
  - label (string): Human-readable label (e.g. "hori", "tanaka-dev")

Returns:
  Full key string. Shown only once — save it.`,
      inputSchema: {
        label: z.string().min(1).max(100).describe("Label for this user key"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false,
        idempotentHint: false, openWorldHint: false,
      },
    },
    async (params) => {
      if (!ctx.hasAdmin) {
        return { isError: true, content: [{ type: "text", text: "Admin Key required." }] };
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
      description: `[ADMIN KEY REQUIRED] List all User Keys.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async () => {
      if (!ctx.hasAdmin) {
        return { isError: true, content: [{ type: "text", text: "Admin Key required." }] };
      }
      const keys = keyStore.listUserKeys();
      return {
        content: [{ type: "text", text: JSON.stringify({
          total: keys.length,
          keys: keys.map((k) => ({
            key_preview: k.key.slice(0, 12) + "..." + k.key.slice(-4),
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
      description: `[ADMIN KEY REQUIRED] Delete a User Key. Active sessions remain until TTL expires.

Args:
  - key (string): Full User Key string to delete`,
      inputSchema: {
        key: z.string().min(1).describe("Full User Key string"),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async (params) => {
      if (!ctx.hasAdmin) {
        return { isError: true, content: [{ type: "text", text: "Admin Key required." }] };
      }
      const deleted = keyStore.deleteUserKey(params.key);
      if (deleted) {
        return { content: [{ type: "text", text: JSON.stringify({ deleted: true, remaining: keyStore.userKeyCount }) }] };
      }
      return { isError: true, content: [{ type: "text", text: "User Key not found." }] };
    }
  );

  // ─────────────────────────────────────────────
  // whoami (all keys)
  // ─────────────────────────────────────────────
  server.registerTool(
    "whoami",
    {
      title: "現在のキー情報",
      description: `Show info about all API keys in this request.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify({
          has_admin: ctx.hasAdmin,
          has_user: ctx.hasUser,
          primary_user_key: ctx.primaryUserKey
            ? { label: ctx.primaryUserKey.label, key_preview: ctx.primaryUserKey.key.slice(0, 12) + "..." }
            : null,
          all_keys: ctx.keys.map((k) => ({
            role: k.role,
            label: k.label,
            key_preview: k.key.slice(0, 12) + "...",
          })),
        }, null, 2) }],
      };
    }
  );
}
