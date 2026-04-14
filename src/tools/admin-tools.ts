import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TokenStore } from "../services/token-store.js";
import { CallerContext } from "./ssh-tools.js";

export function registerAdminTools(
  server: McpServer,
  tokenStore: TokenStore,
  caller: CallerContext
): void {
  // ─────────────────────────────────────────────
  // admin_token_create
  // ─────────────────────────────────────────────
  server.registerTool(
    "admin_token_create",
    {
      title: "APIトークン発行",
      description: `[ADMIN ONLY] Create a new API token for a user. Each token scopes SSH sessions to the token owner.

Args:
  - label (string): Human-readable label (e.g. "hori-claude", "tanaka-dev")
  - is_admin (boolean, optional): Grant admin privileges (default: false)
  - expires_in_days (number, optional): Token expiry in days (null = no expiry)

Returns:
  JSON with token id, full token string, and metadata. The token string is shown only once.`,
      inputSchema: {
        label: z.string().min(1).max(100).describe("Human-readable label for this token"),
        is_admin: z.boolean().default(false).describe("Grant admin privileges (default: false)"),
        expires_in_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Token expiry in days (omit for no expiry)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!caller.isAdmin) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Permission denied: Only admin tokens can create new tokens.",
            },
          ],
        };
      }

      const token = tokenStore.create({
        label: params.label,
        isAdmin: params.is_admin,
        expiresInDays: params.expires_in_days,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: token.id,
                token: token.token,
                label: token.label,
                isAdmin: token.isAdmin,
                createdAt: token.createdAt,
                expiresAt: token.expiresAt,
                message:
                  "⚠️ IMPORTANT: Save this token now! The full token string will NOT be shown again.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // admin_token_list
  // ─────────────────────────────────────────────
  server.registerTool(
    "admin_token_list",
    {
      title: "APIトークン一覧",
      description: `[ADMIN ONLY] List all API tokens with redacted token strings.

Returns:
  JSON array of tokens with id, preview, label, isAdmin, timestamps, and expiry.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      if (!caller.isAdmin) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Permission denied: Only admin tokens can list tokens.",
            },
          ],
        };
      }

      const tokens = tokenStore.list();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: tokens.length, tokens }, null, 2),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // admin_token_revoke
  // ─────────────────────────────────────────────
  server.registerTool(
    "admin_token_revoke",
    {
      title: "APIトークン失効",
      description: `[ADMIN ONLY] Revoke an API token by its ID. All SSH sessions owned by this token will continue until they expire, but no new operations can be performed.

Args:
  - token_id (string): Token ID to revoke (e.g. "tok_0001")`,
      inputSchema: {
        token_id: z.string().min(1).describe("Token ID to revoke (e.g. 'tok_0001')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!caller.isAdmin) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Permission denied: Only admin tokens can revoke tokens.",
            },
          ],
        };
      }

      // Prevent revoking own token
      if (params.token_id === caller.tokenId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Cannot revoke your own admin token. Use another admin token to revoke this one.",
            },
          ],
        };
      }

      const success = tokenStore.revoke(params.token_id);
      if (success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                revoked: params.token_id,
                remaining_tokens: tokenStore.tokenCount,
              }),
            },
          ],
        };
      } else {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Token '${params.token_id}' not found.`,
            },
          ],
        };
      }
    }
  );

  // ─────────────────────────────────────────────
  // admin_whoami
  // ─────────────────────────────────────────────
  server.registerTool(
    "admin_whoami",
    {
      title: "現在のトークン情報",
      description: `Show information about the current API token being used. Available to all tokens.

Returns:
  JSON with token id, label, isAdmin status.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                token_id: caller.tokenId,
                label: caller.label,
                is_admin: caller.isAdmin,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
