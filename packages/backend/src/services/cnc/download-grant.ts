import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived download grants for build packs.
 *
 * The download route accepts either a Bearer user token or one of these. The
 * grant exists for the browser case: a `<a href>` or a `window.location` cannot
 * carry an Authorization header, and putting the buyer's session token in a URL
 * — where it lands in history, in a referrer and in every proxy log — is not an
 * option.
 *
 * So a grant is deliberately the weakest thing that works: five minutes, one
 * order, one user, no revocation. It is not a capability worth stealing, and if
 * one leaks it expires before it is useful. Ownership is still re-checked
 * against the order at redemption — the token says who asked, never what they
 * may have.
 */

/** How long a grant is good for. Long enough to click a link, short enough that a leaked URL is worthless. */
export const CNC_DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * How long a preview-image grant is good for.
 *
 * An hour rather than five minutes because these are `<img src>` attributes on
 * an order page a buyer leaves open while they think about a wall, not a click
 * target — a five-minute image URL would turn into broken images while they
 * read. The trade is safe: what it unlocks is a watermarked PNG stamped NOT FOR
 * MANUFACTURE, and it is still one order, one user, and re-checked on redemption.
 */
export const CNC_PREVIEW_IMAGE_GRANT_TTL_MS = 60 * 60 * 1000;

/** True when grants can be minted and verified at all. Read at call time so tests can set it. */
export function isDownloadGrantConfigured(): boolean {
  return Boolean(process.env.CNC_DOWNLOAD_TOKEN_SECRET);
}

function grantSecret(): string {
  const secret = process.env.CNC_DOWNLOAD_TOKEN_SECRET;
  if (!secret) {
    throw new Error('[cnc-download-grant] CNC_DOWNLOAD_TOKEN_SECRET is not set');
  }
  return secret;
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function sign(payload: string): string {
  return base64url(createHmac('sha256', grantSecret()).update(payload).digest());
}

export type CncDownloadGrantClaims = {
  orderId: number;
  userId: string;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
};

/**
 * Mint a grant for one order and one user.
 *
 * The payload is `orderId:userId:exp`, base64url-encoded so a colon in a user
 * id cannot shift the field boundaries, with the MAC over the ENCODED payload.
 * The expiry is IN the payload, so a longer-lived grant (the preview images)
 * needs no second token shape and no second verifier — only a different `ttlMs`.
 * Signing the encoded form is what makes the split unambiguous on the way back:
 * verification never has to re-encode anything to check the MAC.
 */
export function createDownloadGrant(
  claims: Omit<CncDownloadGrantClaims, 'expiresAt'>,
  now: Date,
  ttlMs: number = CNC_DOWNLOAD_GRANT_TTL_MS,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const payload = base64url(Buffer.from(`${String(claims.orderId)}:${claims.userId}:${String(expiresAt.getTime())}`));
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

/**
 * Verify a grant and return what it claims, or null.
 *
 * Null covers every failure identically — malformed, wrong signature, expired,
 * unconfigured secret — because the caller answers all of them with the same
 * 401. Telling a holder WHICH part of their token was wrong is free help for
 * anyone probing.
 *
 * The MAC is compared with `timingSafeEqual` over equal-length buffers; a
 * length mismatch is rejected first, since that comparison would throw and a
 * signature of the wrong length is not a near miss anyway.
 */
export function verifyDownloadGrant(token: string, now: Date): CncDownloadGrantClaims | null {
  if (!isDownloadGrantConfigured()) return null;

  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;

  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(payload));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

  // Only decoded AFTER the MAC checks out, so a forged payload is never parsed.
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  // Split from the right: a user id may contain colons, an order id and an
  // expiry never can.
  const lastColon = decoded.lastIndexOf(':');
  const firstColon = decoded.indexOf(':');
  if (firstColon <= 0 || lastColon <= firstColon) return null;

  const orderId = Number(decoded.slice(0, firstColon));
  const userId = decoded.slice(firstColon + 1, lastColon);
  const expiresAt = Number(decoded.slice(lastColon + 1));
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return null;
  if (!userId) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null;

  return { orderId, userId, expiresAt };
}
