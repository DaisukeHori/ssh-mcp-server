import { KeyStore, ResolvedKey } from "./key-store.js";

export interface CallerContext {
  /** All resolved keys in the request */
  keys: ResolvedKey[];

  /** Whether at least one Admin Key is present */
  hasAdmin: boolean;

  /** Whether at least one User Key is present */
  hasUser: boolean;

  /** The first User Key (primary). null if no User Keys. */
  primaryUserKey: ResolvedKey | null;

  /** All User Keys provided */
  userKeys: ResolvedKey[];

  /** All raw key strings for User Keys (for session ownership matching) */
  userKeyStrings: string[];
}

/**
 * Build a CallerContext from one or more ?key= values.
 * Returns null if no valid keys found.
 */
export function buildCallerContext(
  keyParams: string | string[] | undefined,
  keyStore: KeyStore
): CallerContext | null {
  // Normalize to array
  let rawKeys: string[];
  if (!keyParams) return null;
  if (typeof keyParams === "string") {
    rawKeys = [keyParams];
  } else {
    rawKeys = keyParams;
  }

  // Resolve each key, skip invalid
  const resolved: ResolvedKey[] = [];
  for (const raw of rawKeys) {
    if (!raw) continue;
    const r = keyStore.resolve(raw);
    if (r) resolved.push(r);
  }

  if (resolved.length === 0) return null;

  const adminKeys = resolved.filter((r) => r.role === "admin");
  const userKeys = resolved.filter((r) => r.role === "user");

  return {
    keys: resolved,
    hasAdmin: adminKeys.length > 0,
    hasUser: userKeys.length > 0,
    primaryUserKey: userKeys.length > 0 ? userKeys[0]! : null,
    userKeys,
    userKeyStrings: userKeys.map((k) => k.key),
  };
}
