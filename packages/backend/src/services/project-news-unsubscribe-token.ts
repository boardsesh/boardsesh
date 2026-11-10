// Signed unsubscribe tokens for project news email (docs/project-news-email.md).
//
// The token is the credential: whoever holds it can switch project news email
// off for one account, and nothing else. It never signs anyone in and never
// turns email on. So a leaked token costs at most an unwanted unsubscribe.
//
// Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(key, payload)).
// The payload carries the user id, a purpose string and issued/expiry times in
// epoch seconds. The key is HKDF-derived from PROJECT_NEWS_UNSUBSCRIBE_SECRET,
// a secret of its own (not NEXTAUTH_SECRET), so rotating the auth secret does
// not break the links in emails already sent, and rotating this one signs
// nobody out. Rotating it does break every unsubscribe link already sent, so
// only rotate it after a leak, and keep the Settings switch as the fallback.

import crypto from 'crypto';
import { backendPublicUrl } from '../email/email-service';

export const PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV = 'PROJECT_NEWS_UNSUBSCRIBE_SECRET';

/** Shorter secrets are refused: the HMAC is only as strong as its key. */
const MIN_SECRET_LENGTH = 32;

const HKDF_INFO = 'boardsesh-project-news-unsubscribe-v1';
const TOKEN_PURPOSE = 'project-news-unsubscribe';

/**
 * A link works for a year after the email went out. The Spam Act asks for at
 * least 30 days; a year covers someone who finds an old email in their inbox.
 */
export const PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/** Path of the unsubscribe endpoint on the backend origin. */
export const PROJECT_NEWS_UNSUBSCRIBE_PATH = '/api/project-news/unsubscribe';

/** Bounds the work an attacker can make the verifier do with a junk token. */
const MAX_TOKEN_LENGTH = 512;

type UnsubscribePayload = {
  p: typeof TOKEN_PURPOSE;
  /** User id. */
  u: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
};

export type UnsubscribeTokenFailure = 'not_configured' | 'malformed' | 'bad_signature' | 'expired';

export type UnsubscribeTokenVerification =
  | { ok: true; userId: string }
  | { ok: false; reason: UnsubscribeTokenFailure };

let cachedSigningKey: { secret: string; key: Buffer } | null = null;

function signingKey(): Buffer | null {
  const secret = process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  if (cachedSigningKey?.secret === secret) return cachedSigningKey.key;
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, '', HKDF_INFO, 32));
  cachedSigningKey = { secret, key };
  return key;
}

/** True when the backend can mint and check unsubscribe links. */
export function isProjectNewsUnsubscribeConfigured(): boolean {
  return signingKey() !== null;
}

function sign(key: Buffer, encodedPayload: string): Buffer {
  return crypto.createHmac('sha256', key).update(encodedPayload).digest();
}

/**
 * Mint an unsubscribe token for one account. Throws when the secret is not
 * configured: a send must never go out without a working unsubscribe link.
 */
export function createProjectNewsUnsubscribeToken(userId: string, nowMs: number = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error(`${PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV} is not configured (at least 32 characters)`);
  if (!userId) throw new Error('userId is required');
  const iat = Math.floor(nowMs / 1000);
  const payload: UnsubscribePayload = {
    p: TOKEN_PURPOSE,
    u: userId,
    iat,
    exp: iat + PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(key, encodedPayload).toString('base64url')}`;
}

function parsePayload(encodedPayload: string): UnsubscribePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { p: purpose, u: userId, iat, exp } = parsed as Record<string, unknown>;
  if (purpose !== TOKEN_PURPOSE) return null;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp)) {
    return null;
  }
  return { p: purpose, u: userId, iat, exp };
}

/**
 * Check a token from an unsubscribe link. The signature is compared in
 * constant time before the payload is trusted; an expired token is refused
 * even when its signature is good.
 */
export function verifyProjectNewsUnsubscribeToken(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): UnsubscribeTokenVerification {
  const key = signingKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [encodedPayload, encodedSignature] = parts;
  const expected = sign(key, encodedPayload);
  const given = Buffer.from(encodedSignature, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const payload = parsePayload(encodedPayload);
  if (!payload) return { ok: false, reason: 'malformed' };
  const nowSeconds = Math.floor(nowMs / 1000);
  // A token can't outlive the lifetime it was minted with, whatever exp says.
  if (payload.exp - payload.iat > PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSeconds >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, userId: payload.u };
}

/**
 * The link a project news email carries, both in its body and in the
 * `List-Unsubscribe` header (with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`).
 */
export function buildProjectNewsUnsubscribeUrl(userId: string, nowMs: number = Date.now()): string {
  const token = createProjectNewsUnsubscribeToken(userId, nowMs);
  return `${backendPublicUrl()}${PROJECT_NEWS_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
}
