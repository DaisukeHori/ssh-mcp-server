import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

export type KeyRole = "admin" | "user";

export interface UserKey {
  key: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeyStoreData {
  userKeys: UserKey[];
}

const USER_KEY_PREFIX = "uk_";
const KEY_BYTE_LENGTH = 24;

export interface ResolvedKey {
  role: KeyRole;
  key: string;
  label: string;
}

export class KeyStore {
  private adminKey: string;
  private userKeys: Map<string, UserKey> = new Map();
  private filePath: string;

  constructor(filePath: string, adminKey: string) {
    this.filePath = filePath;
    this.adminKey = adminKey;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: KeyStoreData = JSON.parse(raw);
      for (const uk of data.userKeys) {
        this.userKeys.set(uk.key, uk);
      }
      console.error(`[KeyStore] Loaded ${this.userKeys.size} user key(s)`);
    } catch (err) {
      console.error(`[KeyStore] Failed to load: ${err}`);
    }
  }

  private save(): void {
    try {
      const data: KeyStoreData = {
        userKeys: Array.from(this.userKeys.values()),
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[KeyStore] Failed to save: ${err}`);
    }
  }

  /**
   * Resolve a key string to its role and metadata.
   * Returns null if invalid.
   */
  resolve(key: string): ResolvedKey | null {
    if (key === this.adminKey) {
      return { role: "admin", key, label: "admin" };
    }
    const uk = this.userKeys.get(key);
    if (uk) {
      uk.lastUsedAt = new Date().toISOString();
      this.save();
      return { role: "user", key: uk.key, label: uk.label };
    }
    return null;
  }

  /**
   * Create a new User Key.
   */
  createUserKey(label: string): UserKey {
    const key = USER_KEY_PREFIX + randomBytes(KEY_BYTE_LENGTH).toString("hex");
    const uk: UserKey = {
      key,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.userKeys.set(key, uk);
    this.save();
    console.error(`[KeyStore] Created user key: ${label}`);
    return uk;
  }

  /**
   * List all User Keys (key is shown in full for admin).
   */
  listUserKeys(): UserKey[] {
    return Array.from(this.userKeys.values());
  }

  /**
   * Delete a User Key by key string.
   */
  deleteUserKey(key: string): boolean {
    const deleted = this.userKeys.delete(key);
    if (deleted) {
      this.save();
      console.error(`[KeyStore] Deleted user key: ${key.slice(0, 12)}...`);
    }
    return deleted;
  }

  get userKeyCount(): number {
    return this.userKeys.size;
  }
}
