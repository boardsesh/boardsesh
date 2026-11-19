// Pure rules for the device tokens the backend hands out on native sign-in
// (#7656). A device token says "this phone has signed in to this account
// before"; the backend uses it to keep a known device out of the per-email
// rejected-password counter. The app treats the token as opaque: it keeps one
// per account, sends the right one back on a password sign-in, and nothing else.
//
// No I/O here. device-token-store.ts owns SecureStore, the serial queue and the
// request header; this module decides what the ledger looks like after a reply,
// an account deletion, or a stored value that does not parse.

/** At most this many accounts keep a token, most recently used first. */
export const MAX_DEVICE_TOKEN_ACCOUNTS = 5;

/** The backend's own limit (`DEVICE_TOKEN_MAX_LENGTH` in @boardsesh/auth-protocol). */
const MAX_DEVICE_TOKEN_LENGTH = 128;
const MAX_USER_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

// Opaque to the app, but it rides in a request header, so only characters that
// can never split or extend a header are kept. Today's tokens are
// `v1.<base64url>.<digits>.<base64url>`, well inside this set.
const HEADER_SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

const LEDGER_FORMAT_VERSION = 1;

export type DeviceTokenAccount = Readonly<{
  userId: string;
  /** Normalised email this account was last signed in to with a password, or null when unknown. */
  email: string | null;
  token: string;
}>;

/** Most recently used first, at most MAX_DEVICE_TOKEN_ACCOUNTS long, one entry per user id. */
export type DeviceTokenLedger = readonly DeviceTokenAccount[];

/** The backend's account-email normalisation: `trim().toLowerCase()`. */
export function normaliseAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True for a value that can be stored and sent back as a header. */
export function isUsableDeviceToken(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= MAX_DEVICE_TOKEN_LENGTH &&
    HEADER_SAFE_TOKEN.test(candidate)
  );
}

function isUsableUserId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_USER_ID_LENGTH;
}

export function usableDeviceTokenEmail(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const normalised = normaliseAccountEmail(candidate);
  return normalised.length > 0 && normalised.length <= MAX_EMAIL_LENGTH ? normalised : null;
}

/**
 * The token a sign-in reply carries, or null.
 *
 * `userId` comes from the reply; `fallbackUserId` (the JWT's subject) covers a
 * reply that carries a token but no user id, and is only called then. A backend
 * that never returns the field — production today — always yields null without
 * calling it, so nothing is decoded and nothing is stored.
 */
export function readDeviceTokenFromReply(
  reply: unknown,
  fallbackUserId?: () => string | null | undefined,
): { userId: string; token: string } | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const fields = reply as Record<string, unknown>;
  if (!isUsableDeviceToken(fields.deviceToken)) return null;
  const userId = isUsableUserId(fields.userId) ? fields.userId : fallbackUserId?.();
  if (!isUsableUserId(userId)) return null;
  return { userId, token: fields.deviceToken };
}

/**
 * Parse the stored ledger. Anything malformed is dropped, never thrown: a value
 * that is not JSON, or from another format version, reads as an empty ledger,
 * and a malformed entry inside a good ledger is skipped on its own.
 */
export function parseDeviceTokenLedger(stored: string | null): DeviceTokenLedger {
  if (stored === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== LEDGER_FORMAT_VERSION || !Array.isArray(envelope.accounts)) return [];

  const accounts: DeviceTokenAccount[] = [];
  const seenUserIds = new Set<string>();
  for (const candidate of envelope.accounts as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (!isUsableUserId(entry.userId) || !isUsableDeviceToken(entry.token)) continue;
    if (seenUserIds.has(entry.userId)) continue;
    seenUserIds.add(entry.userId);
    accounts.push({ userId: entry.userId, email: usableDeviceTokenEmail(entry.email), token: entry.token });
    if (accounts.length === MAX_DEVICE_TOKEN_ACCOUNTS) break;
  }
  return accounts;
}

export function serializeDeviceTokenLedger(ledger: DeviceTokenLedger): string {
  return JSON.stringify({
    v: LEDGER_FORMAT_VERSION,
    accounts: ledger.map(({ userId, email, token }) => ({ userId, email, token })),
  });
}

/**
 * The ledger after a reply carried `token` for `userId`.
 *
 * The account moves to the front and its token is replaced (a refresh reply
 * replaces the one a sign-in stored). `email` is the address a password sign-in
 * or registration used; other replies (OAuth, exchange, refresh) pass none and
 * the account keeps the email it already had. An email names one account: any
 * other entry holding it loses it, so the choice at sign-in is never ambiguous.
 * The oldest accounts beyond MAX_DEVICE_TOKEN_ACCOUNTS are dropped.
 */
export function mergeDeviceTokenReply(
  ledger: DeviceTokenLedger,
  reply: { userId: string; token: string; email?: string | null },
): DeviceTokenLedger {
  const previous = ledger.find((account) => account.userId === reply.userId);
  const replyEmail = reply.email === undefined || reply.email === null ? null : usableDeviceTokenEmail(reply.email);
  const email = replyEmail ?? previous?.email ?? null;
  const others = ledger
    .filter((account) => account.userId !== reply.userId)
    .map((account) => (email !== null && account.email === email ? { ...account, email: null } : account));
  return [{ userId: reply.userId, email, token: reply.token }, ...others].slice(0, MAX_DEVICE_TOKEN_ACCOUNTS);
}

/**
 * The ledger after the app learned `email` is the account email of `userId`
 * (the signed-in profile names both). Only an account that already holds a
 * token is touched; nothing is added. The email moves off any other entry, so
 * one email still names one account. Returns the same ledger when nothing changes.
 */
export function setDeviceTokenAccountEmail(
  ledger: DeviceTokenLedger,
  userId: string,
  email: string,
): DeviceTokenLedger {
  const normalised = usableDeviceTokenEmail(email);
  if (normalised === null) return ledger;
  const account = ledger.find((entry) => entry.userId === userId);
  if (!account) return ledger;
  const claimedElsewhere = ledger.some((entry) => entry.userId !== userId && entry.email === normalised);
  if (account.email === normalised && !claimedElsewhere) return ledger;
  return ledger.map((entry) => {
    if (entry.userId === userId) return { ...entry, email: normalised };
    return entry.email === normalised ? { ...entry, email: null } : entry;
  });
}

/** The ledger without `userId` (account deleted on this device). */
export function forgetDeviceTokenAccount(ledger: DeviceTokenLedger, userId: string): DeviceTokenLedger {
  return ledger.filter((account) => account.userId !== userId);
}

/** The token stored for the account signed in to with `email`, or null when none matches. */
export function chooseDeviceTokenForEmail(ledger: DeviceTokenLedger, email: string): string | null {
  const normalised = usableDeviceTokenEmail(email);
  if (normalised === null) return null;
  return ledger.find((account) => account.email === normalised)?.token ?? null;
}
