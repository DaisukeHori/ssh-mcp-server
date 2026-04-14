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
  // user_key_create
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_create",
    {
      title: "User Key発行",
      description: `[ADMIN KEY REQUIRED] Create a new User Key for SSH MCP access.

PURPOSE:
  User Keys allow users to create SSH connections via ssh_connect.
  Each User Key is a unique credential starting with "uk_".

WORKFLOW:
  1. Admin calls user_key_create(label="hori") → returns full key "uk_a707e477..."
  2. The key is shown ONLY ONCE — save it immediately
  3. User adds ?key=uk_a707e477... to their MCP connector URL
  4. User can now call ssh_connect to create SSH sessions

LABELS:
  Labels are human-readable identifiers (e.g. "hori", "tanaka-dev", "ci-bot").
  They appear in ssh_list_sessions to identify who created each session.

SECURITY:
  - The full key is returned only at creation time
  - user_key_list shows only a preview (first 12 + last 4 chars)
  - Deleting a key prevents new connections but doesn't kill existing sessions`,
      inputSchema: {
        label: z.string().min(1).max(100).describe("Human-readable label for this user (e.g. 'hori', 'tanaka', 'deploy-bot')"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      if (!ctx.hasAdmin) {
        return { isError: true, content: [{ type: "text", text: "Admin Key required. This tool requires ?key=ADMIN_KEY in the URL." }] };
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
  // user_key_list
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_list",
    {
      title: "User Key一覧",
      description: `[ADMIN KEY REQUIRED] List all User Keys with their labels, creation dates, and last used dates.

USE CASES:
  - See all users who have MCP access
  - Find a key to delete
  - Check when keys were last used
  - Audit access

NOTE: Full keys are shown in the response. Key previews are also included for quick identification.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  // user_key_delete
  // ─────────────────────────────────────────────
  server.registerTool(
    "user_key_delete",
    {
      title: "User Key削除",
      description: `[ADMIN KEY REQUIRED] Delete a User Key to revoke MCP access.

BEHAVIOR:
  - The User Key is permanently deleted from user-keys.json
  - The user can no longer create new SSH connections
  - The user can no longer list their sessions
  - EXISTING sessions created by this key are NOT killed — they remain until TTL expires
  - To also kill sessions, use ssh_disconnect for each affected session_token

FINDING THE KEY:
  Use user_key_list to see all keys. Copy the full key string (starting with "uk_").`,
      inputSchema: {
        key: z.string().min(1).describe("Full User Key string to delete (starts with 'uk_'). Get this from user_key_list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      if (!ctx.hasAdmin) {
        return { isError: true, content: [{ type: "text", text: "Admin Key required." }] };
      }
      const deleted = keyStore.deleteUserKey(params.key);
      if (deleted) {
        return { content: [{ type: "text", text: JSON.stringify({ deleted: true, remaining: keyStore.userKeyCount }) }] };
      }
      return { isError: true, content: [{ type: "text", text: "User Key not found. Use user_key_list to see available keys." }] };
    }
  );

  // ─────────────────────────────────────────────
  // whoami
  // ─────────────────────────────────────────────
  server.registerTool(
    "whoami",
    {
      title: "現在のキー情報",
      description: `Show information about all API keys in the current request.

RETURNS:
  - has_admin: whether an Admin Key is present
  - has_user: whether at least one User Key is present
  - primary_user_key: the first User Key (used as owner for ssh_connect)
  - all_keys: list of all keys with their roles and labels

USE CASES:
  - Verify your authentication setup
  - Check which keys are active in the current connector URL
  - Debug permission issues (e.g. "why can't I ssh_connect?" → no User Key)`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
