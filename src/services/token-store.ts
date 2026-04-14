import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

export interface APIToken {
  id: string;
  token: string;
  label: string;
  isAdmin: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface TokenStoreData {
  tokens: APIToken[];
}

const TOKEN_PREFIX = "sshm_";
const TOKEN_BYTE_LENGTH = 32;

export class TokenStore {
  private tokens: Map<string, APIToken> = new Map(); // keyed by token string
  private tokensById: Map<string, APIToken> = new Map(); // keyed by id
  private filePath: string;
  private idCounter = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: TokenStoreData = JSON.parse(raw);
      for (const t of data.tokens) {
        this.tokens.set(t.token, t);
        this.tokensById.set(t.id, t);
        // Track max id counter
        const num = parseInt(t.id.replace("tok_", ""), 10);
        if (!isNaN(num) && num > this.idCounter) {
          this.idCounter = num;
        }
      }
      console.error(`[TokenStore] Loaded ${this.tokens.size} token(s) from ${this.filePath}`);
    } catch (err) {
      console.error(`[TokenStore] Failed to load ${this.filePath}: ${err}`);
    }
  }

  private save(): void {
    try {
      const data: TokenStoreData = {
        tokens: Array.from(this.tokens.values()),
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[TokenStore] Failed to save: ${err}`);
    }
  }

  private generateId(): string {
    this.idCounter++;
    return `tok_${this.idCounter.toString().padStart(4, "0")}`;
  }

  private generateTokenString(): string {
    return TOKEN_PREFIX + randomBytes(TOKEN_BYTE_LENGTH).toString("hex");
  }

  /**
   * Create a new API token.
   */
  create(options: {
    label: string;
    isAdmin?: boolean;
    expiresInDays?: number;
  }): APIToken {
    const id = this.generateId();
    const token = this.generateTokenString();
    const now = new Date();

    const apiToken: APIToken = {
      id,
      token,
      label: options.label,
      isAdmin: options.isAdmin ?? false,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt: options.expiresInDays
        ? new Date(now.getTime() + options.expiresInDays * 86400000).toISOString()
        : null,
    };

    this.tokens.set(token, apiToken);
    this.tokensById.set(id, apiToken);
    this.save();

    console.error(`[TokenStore] Created token ${id} (${options.label}) admin=${apiToken.isAdmin}`);
    return apiToken;
  }

  /**
   * Validate a bearer token string. Returns the token record or null.
   */
  validate(tokenString: string): APIToken | null {
    const t = this.tokens.get(tokenString);
    if (!t) return null;

    // Check expiry
    if (t.expiresAt && new Date(t.expiresAt) < new Date()) {
      return null;
    }

    // Update last used
    t.lastUsedAt = new Date().toISOString();
    this.save();

    return t;
  }

  /**
   * Revoke a token by id.
   */
  revoke(tokenId: string): boolean {
    const t = this.tokensById.get(tokenId);
    if (!t) return false;

    this.tokens.delete(t.token);
    this.tokensById.delete(t.id);
    this.save();

    console.error(`[TokenStore] Revoked token ${tokenId}`);
    return true;
  }

  /**
   * List all tokens (redacted for non-admin viewing).
   */
  list(): Array<{
    id: string;
    token_preview: string;
    label: string;
    isAdmin: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
  }> {
    return Array.from(this.tokens.values()).map((t) => ({
      id: t.id,
      token_preview: t.token.slice(0, 12) + "..." + t.token.slice(-4),
      label: t.label,
      isAdmin: t.isAdmin,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
    }));
  }

  /**
   * Get a token by id (full token visible for admin).
   */
  getById(tokenId: string): APIToken | undefined {
    return this.tokensById.get(tokenId);
  }

  get tokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Bootstrap: ensure at least one admin token exists.
   * Returns the admin token string if newly created.
   */
  ensureAdminToken(): string | null {
    const hasAdmin = Array.from(this.tokens.values()).some((t) => t.isAdmin);
    if (hasAdmin) return null;

    const t = this.create({ label: "Initial Admin", isAdmin: true });
    console.error(`[TokenStore] *** INITIAL ADMIN TOKEN CREATED ***`);
    console.error(`[TokenStore] Token: ${t.token}`);
    console.error(`[TokenStore] Save this token! It won't be shown again.`);
    return t.token;
  }
}
