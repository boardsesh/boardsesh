import { assertLegacyIdentityWriterAllowed } from '../auth/current-store/identity-writer-gate';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityReceipt,
} from '../auth/authority/router';
import { authenticateIdentityPassword } from '../auth/authority/password-verification';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { getCredentialDatabase } from '../auth/credential-database';
import { NATIVE_BROWSER_HANDOFF_PREFIX, redeemNativeBrowserHandoff } from '../auth/authority/native-browser-handoff';
import {
  createWatchPairCapability,
  parseWatchPairCapability,
  WATCH_PAIR_CAPABILITY_TTL_SECONDS,
} from '../auth/watch-pairing-capability';
import { watchPairingMode } from '../auth/watch-pairing-configuration';
import { nativeSessionRequiresAccountCutoff, UNKNOWN_WEB_NATIVE_SESSION_PREFIX } from '../auth/native-session-ancestry';
import {
  currentNativeRevocationMode,
  parseNativeRevocationMode,
} from '../auth/authority/native-revocation-configuration';
import { legacyBridgeMode } from '../auth/authority/bridge';
import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { cleanupNativeRefreshRows } from '../auth/authority/native-refresh-retention';
import { bindNativeRefreshSession } from '../auth/authority/native-session';
import { revokeNativeCredentials } from '../auth/authority/native-revocation';
import { identityMirrorMode } from '../auth/authority/mirror-configuration';
import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';
import { eq, and, isNull, DrizzleQueryError, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { normalizeAccountEmail, soleAccount } from '@boardsesh/auth-protocol/account-email';
import { findAccountHoldersByEmail } from '@boardsesh/db/queries/account-email';
import { mobileRefreshTokens, users, accounts, userProfiles, authSessionDenials } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { applyCorsHeaders } from './cors';
import { validateHttpAuthToken } from './auth-admission';
import {
  admitsCredential,
  AuthAdmissionUnavailableError,
  AuthSubjectDeniedError,
  isAuthAdmissionUnavailable,
  isHumanSubjectActive,
  PasswordProofStaleError,
  requireHumanSubjectForIssuance,
  lockPasswordProofAuthority,
  type PasswordProof,
} from '../auth/human-admission';
import { decideCredential, type SubjectCutoffState } from '../auth/credential-cutoffs';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import {
  currentStoreAuthorityConfiguration,
  currentStoreNativeRegistrationConfiguration,
  currentStoreNativeOAuthConfiguration,
} from '../auth/current-store/authority-configuration';
import {
  boundSignInLockWaits,
  transactionSettings,
  type WebPasswordAuthority,
} from '../auth/current-store/command-context';
import { CurrentStoreFoundationError, lockIdentityManifest } from '../auth/current-store/foundation-context';
import { insertReservedPasswordIdentity } from '../auth/current-store/reserved-password-registration';
import {
  resolveReservedNativeOAuthIdentity,
  resolveNativeOAuthDisplayName as resolveDisplayName,
  type NativeOAuthProvider as OAuthProvider,
  type VerifiedNativeOAuthIdentity as VerifiedOAuthIdentity,
} from '../auth/current-store/native-oauth-identity';
import {
  parseCurrentStorePasswordRegistration,
  prepareCurrentStorePasswordRegistration,
  insertCurrentStorePasswordIdentity,
} from '../auth/current-store/password-identity';

/** Generic error returned for all credential validation failures. */
const INVALID_CREDENTIALS_ERROR = 'Invalid email or password';

// Transfer tokens are short-lived (120s) and exchanged between our own
// servers, so 5s tolerance is sufficient. Long-lived JWTs use 60s in
// jose's clockTolerance to handle mobile device clock drift.
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

/**
 * Maximum allowed lifetime for a transfer token (seconds).
 * Transfer tokens are intended to live 120s. This cap (120s + 5s tolerance)
 * prevents a compromised web issuer from embedding an arbitrarily long exp.
 */
const MAX_TRANSFER_TOKEN_LIFETIME_SECONDS = 125;

/** JWT lifetime for mobile sessions. */
const JWT_EXPIRY = '7d';
const JWT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Refresh token lifetime. */
const REFRESH_TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum request body size for these endpoints. */
const MAX_BODY_BYTES = 4096;

/** JWT issuer claim for mobile tokens. */
const JWT_ISSUER = 'boardsesh';

/** JWT audience claim for mobile tokens. */
const JWT_AUDIENCE = 'boardsesh-mobile';

// ---------------------------------------------------------------------------
// Transfer token replay prevention
// ---------------------------------------------------------------------------

/**
 * In-memory fallback for consumed transfer token signatures when Redis is
 * unavailable. When Redis is connected, tokens are stored with SET NX EX for
 * atomic, multi-instance-safe replay prevention.
 */
const consumedTransferTokens = new Map<string, number>();

/** TTL for consumed token entries (125s — slightly longer than the 120s token TTL). */
// At most 125 signed seconds + two 5-second verification tolerances, plus
// 60 seconds of clock offset in each replica, is 255 seconds. Five minutes
// also covers whole-second rounding and scheduling margin across replicas.
const CONSUMED_TOKEN_TTL_SECONDS = 5 * 60;
const CONSUMED_TOKEN_TTL_MS = CONSUMED_TOKEN_TTL_SECONDS * 1000;

/** Cleanup interval for expired consumed token entries. */
const CONSUMED_TOKEN_CLEANUP_INTERVAL_MS = 60_000;

/** Max entries before triggering early eviction. */
const MAX_CONSUMED_TOKENS = 10_000;

/** Redis key prefix for consumed transfer tokens. */
const CONSUMED_TOKEN_REDIS_PREFIX = 'boardsesh:native-auth:consumed:';

/** Evict stale entries from the consumed-token map. */
function evictStaleConsumedTokens(): void {
  const cutoff = Date.now() - CONSUMED_TOKEN_TTL_MS;
  for (const [signature, timestamp] of consumedTransferTokens) {
    if (timestamp < cutoff) consumedTransferTokens.delete(signature);
  }
}

// Periodically evict stale consumed-token entries so the map doesn't grow unbounded.
const consumedTokenEvictionHandle = setInterval(evictStaleConsumedTokens, CONSUMED_TOKEN_CLEANUP_INTERVAL_MS);
if (typeof consumedTokenEvictionHandle.unref === 'function') consumedTokenEvictionHandle.unref();

/**
 * Attempt to mark a transfer token signature as consumed.
 * Returns 'consumed' if freshly consumed, 'replay' if already used, 'overloaded' if map is full.
 *
 * When Redis is connected, uses SET NX EX for atomic multi-instance replay prevention.
 * Falls back to the in-memory map otherwise (single-instance only).
 */
async function markTokenConsumed(tokenSignature: string): Promise<'consumed' | 'replay' | 'overloaded'> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      // Keep the replay key beyond the latest accepted signed expiry plus skew.
      const result = await publisher.set(redisKey, '1', 'EX', CONSUMED_TOKEN_TTL_SECONDS, 'NX');
      return result === 'OK' ? 'consumed' : 'replay';
    } catch {
      // Redis failure: fall through to in-memory map so the endpoint stays available.
      logger.warn('[NativeAuth] Redis replay store unavailable', { code: 'REDIS_REPLAY_WRITE_UNAVAILABLE' });
    }
  }

  if (legacyBridgeMode(process.env) === 'on') return 'overloaded';
  // In-memory fallback (single-instance only)
  if (consumedTransferTokens.has(tokenSignature)) {
    return 'replay';
  }

  if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
    evictStaleConsumedTokens();
    if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
      return 'overloaded';
    }
  }

  consumedTransferTokens.set(tokenSignature, Date.now());
  return 'consumed';
}

/**
 * Check if a transfer token signature has already been consumed (read-only check).
 * Used for the early-reject path before verifying the HMAC.
 */
async function isTokenConsumed(tokenSignature: string): Promise<boolean> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      const result = await publisher.exists(redisKey);
      return result === 1;
    } catch {
      logger.warn('[NativeAuth] Redis replay check unavailable', { code: 'REDIS_REPLAY_READ_UNAVAILABLE' });
    }
  }
  return consumedTransferTokens.has(tokenSignature);
}

// ---------------------------------------------------------------------------
// Per-instance auth rate limiting (IP or presented-refresh digest)
//
// Per-instance only — with N backend instances the effective limit is
// AUTH_RATE_LIMIT_MAX × N per bucket: IP for other rate-limited auth endpoints,
// or SHA-256 of the presented refresh secret. Redis-backed limiting would add
// a round-trip to every auth request for marginal benefit given that
// the high-risk replay path is already Redis-backed (SET NX EX).
// ---------------------------------------------------------------------------

type AuthRateLimitEntry = {
  count: number;
  resetAt: number;
};

/** IP bucket state for rate-limited non-refresh auth endpoints. */
const authRateLimitMap = new Map<string, AuthRateLimitEntry>();

/** Only secrets found in the refresh table can occupy these bounded buckets. */
const refreshRateLimitMap = new Map<string, AuthRateLimitEntry>();

/** Missing secrets cannot consume the capacity reserved for existing clients. */
const invalidRefreshRateLimitMap = new Map<string, AuthRateLimitEntry>();
let invalidRefreshCapacityRetryAt = 0;

/** Maximum requests per IP or refresh-digest bucket per minute. */
const AUTH_RATE_LIMIT_MAX = 10;

/** Rate limit window in milliseconds (1 minute). */
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum entries in each map before eviction or capacity refusal. */
const MAX_RATE_LIMIT_ENTRIES = 50_000;

/** A full invalid-input map must not trigger 50,000-entry scans per request. */
const INVALID_REFRESH_CAPACITY_RECHECK_MS = 1000;

/** Evict expired entries from the rate limit map. */
function evictExpiredRateLimitEntries(entries: Map<string, AuthRateLimitEntry>): void {
  const now = Date.now();
  for (const [bucketKey, entry] of entries) {
    if (now >= entry.resetAt) entries.delete(bucketKey);
  }
}

// Periodically clean up expired rate limit entries.
const rateLimitEvictionHandle = setInterval(() => {
  evictExpiredRateLimitEntries(authRateLimitMap);
  evictExpiredRateLimitEntries(refreshRateLimitMap);
  evictExpiredRateLimitEntries(invalidRefreshRateLimitMap);
}, AUTH_RATE_LIMIT_WINDOW_MS);
if (typeof rateLimitEvictionHandle.unref === 'function') rateLimitEvictionHandle.unref();

/**
 * Check one per-instance IP or SHA-256 refresh-digest quota bucket.
 * Returns the number of seconds until the limit resets, or null if allowed.
 * Returns -1 if the rate limit map is full and cannot accept new entries
 * (callers should respond with 503).
 */
function checkAuthRateLimit(bucketKey: string, entries = authRateLimitMap): number | null {
  const now = Date.now();
  const entry = entries.get(bucketKey);

  if (!entry || now >= entry.resetAt) {
    if (!entry && entries.size >= MAX_RATE_LIMIT_ENTRIES) {
      if (entries === invalidRefreshRateLimitMap && now < invalidRefreshCapacityRetryAt) return -1;
      evictExpiredRateLimitEntries(entries);
      if (entries === invalidRefreshRateLimitMap) {
        invalidRefreshCapacityRetryAt = now + INVALID_REFRESH_CAPACITY_RECHECK_MS;
      }
      if (entries.size >= MAX_RATE_LIMIT_ENTRIES) {
        logger.warn('[NativeAuth] Rate limit capacity reached');
        return -1;
      }
    }
    entries.set(bucketKey, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return null;
  }

  if (entry.count >= AUTH_RATE_LIMIT_MAX) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count++;
  return null;
}

function respondRefreshRateLimit(res: ServerResponse, retryAfter: number | null): boolean {
  if (retryAfter === null) return false;
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return true;
  }
  res.setHeader('Retry-After', String(retryAfter));
  sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
  return true;
}

/**
 * Extract the client IP from an incoming request.
 *
 * Uses `req.socket.remoteAddress` exclusively. X-Forwarded-For is user-controlled
 * and trusting its leftmost entry lets attackers bypass the rate limiter by
 * spoofing arbitrary IPs. Behind a reverse proxy (e.g. Railway), remoteAddress
 * is the proxy IP, which means sign-ins share one rate-limit bucket. Refresh
 * uses a separate bucket keyed by the hash of its presented secret.
 */
function getClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getSigningSecret(): Uint8Array | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Transfer token verification (mirrors packages/web native-oauth-transfer.ts)
// ---------------------------------------------------------------------------

type TransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
  accountCreation?: unknown;
  gen?: unknown;
  auth_time?: unknown;
  link_guarded?: unknown;
  legacy_no_sid?: unknown;
  authSessionId?: unknown;
  attemptId?: unknown;
  provider?: unknown;
};

function verifyTransferToken(token: string): {
  userId: string;
  generation: number;
  authSessionId: string | null;
  authenticatedAt: Date | null;
  accountCreation?: AccountCreationReceipt;
  requiresAccountCutoff: boolean;
  validUntil: number;
} | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthAdmissionUnavailableError();

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encodedPayload, signature] = parts;

  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  // Pad both buffers to the same length so the comparison is always
  // constant-time — no length oracle, no JIT short-circuit.
  const maxLen = Math.max(sigBuffer.length, expectedSigBuffer.length);
  const paddedSig = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  sigBuffer.copy(paddedSig);
  expectedSigBuffer.copy(paddedExpected);

  if (!crypto.timingSafeEqual(paddedSig, paddedExpected)) {
    return null;
  }

  let payload: TransferPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TransferPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.userId !== 'string' ||
    !payload.userId ||
    payload.userId.length > 256 ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.iat) ||
    payload.exp <= payload.iat ||
    payload.iat <= 0 ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  // Reject tokens with an unreasonably long lifetime (e.g. a compromised
  // web issuer embedding a far-future exp).
  if (payload.exp - payload.iat > MAX_TRANSFER_TOKEN_LIFETIME_SECONDS) {
    return null;
  }

  const receipt = parseAccountCreationReceipt(payload.accountCreation);
  const accountCreation =
    receipt?.userId === payload.userId &&
    receipt.provider === payload.provider &&
    typeof payload.authSessionId === 'string' &&
    payload.authSessionId.length > 0 &&
    typeof payload.attemptId === 'string' &&
    /^[0-9a-f]{32}$/.test(payload.attemptId)
      ? receipt
      : undefined;
  const generation = payload.gen ?? 0;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null;
  if (
    payload.authSessionId !== undefined &&
    (typeof payload.authSessionId !== 'string' || !payload.authSessionId.trim() || payload.authSessionId.length > 256)
  )
    return null;
  if (payload.legacy_no_sid !== undefined && payload.legacy_no_sid !== true) return null;
  const sourceSessionId = typeof payload.authSessionId === 'string' ? payload.authSessionId : null;
  const inheritedAncestry = sourceSessionId === null ? true : nativeSessionRequiresAccountCutoff(sourceSessionId);
  if (inheritedAncestry === null) return null;
  const authenticationTime = readAuthTimeClaim(payload.auth_time, Date.now());
  const authenticatedAt =
    payload.link_guarded === true && authenticationTime !== null && authenticationTime <= payload.iat
      ? new Date(authenticationTime * 1000)
      : null;
  return {
    userId: payload.userId,
    generation,
    authSessionId: sourceSessionId,
    requiresAccountCutoff: payload.legacy_no_sid === true || inheritedAncestry,
    // The installed verifier compares integer seconds with an inclusive
    // tolerance. Reject at the first millisecond outside that same window.
    validUntil: (payload.exp + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000,
    authenticatedAt,
    ...(accountCreation ? { accountCreation } : {}),
  };
}

function accountCreationReceipt(
  userId: string,
  accountCreated: boolean,
  provider: AccountCreationReceipt['provider'],
  createdAt: Date,
): AccountCreationReceipt | undefined {
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) return undefined;
  return { userId, accountCreated, provider, createdAt: createdAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Token generation helpers
// ---------------------------------------------------------------------------

type RefreshStamps = Pick<
  typeof mobileRefreshTokens.$inferSelect,
  'subjectGeneration' | 'nativeGeneration' | 'authenticatedAt' | 'sessionId' | 'expiresAt'
>;

/**
 * What a new token pair descends from. Every reader decides the stamps by
 * `decideCredential` (BA-04 PR 2).
 */
type NativeCredentialOrigin =
  /**
   * A proof this request checked: password, provider token, transfer token or
   * watch code. `authenticatedAt` is when a password or provider proof passed;
   * null for a transfer token or watch code, which carry a sign-in made elsewhere.
   * `passwordProof` is what bcrypt checked, compared again under the user lock.
   */
  | { readonly kind: 'sign-in'; readonly authenticatedAt: Date | null; readonly passwordProof?: PasswordProof }
  /** The refresh row this request consumed, under the same user lock. */
  | { readonly kind: 'refresh'; readonly parent: RefreshStamps }
  /** A legacy UID-only pending code is valid only before staged authority/cutoffs exist. */
  | { readonly kind: 'legacy-pairing' }
  | {
      readonly kind: 'transfer';
      readonly generation: number;
      readonly authSessionId: string | null;
      readonly authenticatedAt: Date | null;
      readonly requiresAccountCutoff: boolean;
      /** Only a native source is bound to native sign-out; web handoff remains independent. */
      readonly nativeGeneration?: number;
      readonly capabilityExpiresAt?: number;
    };

type CredentialStamps = {
  subjectGeneration: number;
  nativeGeneration: number;
  authenticatedAt: Date | null;
  sessionId: string;
};

/** A sign-in fresh at this request, for a proof made by this request. */
function signedInNow(): NativeCredentialOrigin {
  return { kind: 'sign-in', authenticatedAt: new Date() };
}

const LEGACY_PAIRING_WITHOUT_SOURCE: NativeCredentialOrigin = { kind: 'legacy-pairing' };

function legacyPairingStateAllowed(subject: SubjectCutoffState): boolean {
  return subject.generation === 0 && subject.nativeGeneration === 0 && subject.deniedSessionKeys.size === 0;
}

/** Preflight only: no Redis request runs inside this short eligibility transaction. */
async function preflightLegacyPairing(userId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const manifest = await lockIdentityManifest(transaction);
    if (manifest?.phase === 'enforced') throw new AuthAdmissionUnavailableError();
    const subject = await requireHumanSubjectForIssuance(transaction, userId);
    if (!legacyPairingStateAllowed(subject)) throw new AuthAdmissionUnavailableError();
  });
}

function credentialStamps(origin: NativeCredentialOrigin, generations: SubjectCutoffState): CredentialStamps {
  if (origin.kind === 'sign-in' || origin.kind === 'legacy-pairing') {
    return {
      subjectGeneration: generations.generation,
      nativeGeneration: generations.nativeGeneration,
      authenticatedAt: origin.kind === 'sign-in' ? origin.authenticatedAt : null,
      sessionId: crypto.randomUUID(),
    };
  }
  if (origin.kind === 'transfer')
    return {
      subjectGeneration: origin.generation,
      nativeGeneration: generations.nativeGeneration,
      authenticatedAt: origin.authenticatedAt,
      sessionId: `${origin.requiresAccountCutoff ? UNKNOWN_WEB_NATIVE_SESSION_PREFIX : ''}${crypto.randomUUID()}`,
    };
  // Copy, never re-read: a child is never newer than its parent. A row from
  // before the stamps stands for generation 0, so its child is stamped 0, and
  // an unknown sign-in time stays unknown.
  const { parent } = origin;
  return {
    subjectGeneration: parent.subjectGeneration ?? 0,
    nativeGeneration: parent.nativeGeneration ?? 0,
    authenticatedAt: parent.authenticatedAt ?? null,
    sessionId: parent.sessionId ?? crypto.randomUUID(),
  };
}

/**
 * `lockedState` is the state a caller already read under this transaction's user
 * lock (the refresh path), so the lock and its read are not taken twice.
 */
async function generateTokenPair(
  userId: string,
  transaction: Parameters<Parameters<DbInstance['transaction']>[0]>[0],
  origin: NativeCredentialOrigin,
  lockedState?: SubjectCutoffState,
): Promise<{
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}> {
  const assertOriginActive = () => {
    if (
      origin.kind === 'transfer' &&
      origin.capabilityExpiresAt !== undefined &&
      Date.now() >= origin.capabilityExpiresAt
    )
      throw new AuthSubjectDeniedError();
  };
  assertOriginActive();
  let generations = lockedState;
  if (!generations) {
    const passwordProof = origin.kind === 'sign-in' ? origin.passwordProof : undefined;
    // A password sign-in gives up on a held user row after 250 ms and answers
    // 503, which the app retries; issuance that must win keeps 4 s.
    await transactionSettings(transaction);
    if (passwordProof) {
      await lockPasswordProofAuthority(transaction, passwordProof);
      await boundSignInLockWaits(transaction);
    }
    if (origin.kind === 'legacy-pairing') {
      const manifest = await lockIdentityManifest(transaction);
      if (manifest?.phase === 'enforced') throw new AuthSubjectDeniedError();
    }
    generations = await requireHumanSubjectForIssuance(transaction, userId, passwordProof);
  }
  if (origin.kind === 'legacy-pairing' && !legacyPairingStateAllowed(generations)) throw new AuthSubjectDeniedError();
  if (origin.kind === 'transfer') {
    assertOriginActive();
    if (
      origin.generation !== generations.generation ||
      (origin.nativeGeneration !== undefined && origin.nativeGeneration !== generations.nativeGeneration)
    )
      throw new AuthSubjectDeniedError();
    if (origin.authSessionId) {
      const [denial] = await transaction
        .select()
        .from(authSessionDenials)
        .where(eq(authSessionDenials.sessionId, origin.authSessionId));
      if (denial) throw new AuthSubjectDeniedError();
    }
  }
  if (origin.kind === 'refresh') {
    // A child copies its parent's stamps, so a parent from before a reset or an
    // app sign-out would mint a pair every reader refuses, and the app would
    // loop refresh -> 401. Refuse the parent instead: a 401 here signs the app out.
    // Every cutoff writer locks `users` FOR UPDATE first, and this issuer holds
    // KEY SHARE, so no cutoff commits between this read and the child's insert.
    const { parent } = origin;
    const decision = decideCredential(
      {
        kind: 'native-refresh',
        subjectGeneration: parent.subjectGeneration,
        nativeGeneration: parent.nativeGeneration,
        authenticatedAt: parent.authenticatedAt,
      },
      generations,
      Date.now(),
    );
    if (!admitsCredential(decision, 'refresh')) throw new AuthSubjectDeniedError();
  }
  const signingSecret = getSigningSecret();
  if (!signingSecret) throw new AuthAdmissionUnavailableError();
  const stamps = credentialStamps(origin, generations);
  if (nativeSessionRequiresAccountCutoff(stamps.sessionId) === null) throw new AuthSubjectDeniedError();
  if (origin.kind === 'refresh') {
    // The parent stays readable through rollback; the canonical binding is additive.
    const parentExpiresAt = origin.parent.expiresAt;
    await bindNativeRefreshSession(
      transaction,
      userId,
      stamps,
      parentExpiresAt,
      new Date(),
      currentNativeRevocationMode(),
    );
  }

  // Generate JWT. Clients read only `sub`; the stamps are for the server.
  const jwtExpiresAt = new Date(Date.now() + JWT_EXPIRY_MS);
  const jwt = await new SignJWT({
    sub: userId,
    gen: stamps.subjectGeneration,
    ngen: stamps.nativeGeneration,
    sid: stamps.sessionId,
    ...(stamps.authenticatedAt ? { auth_time: Math.floor(stamps.authenticatedAt.getTime() / 1000) } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_EXPIRY)
    .sign(signingSecret);

  // Generate refresh token and store its hash
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  await transaction.insert(mobileRefreshTokens).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    ...stamps,
  });

  assertOriginActive();
  return {
    userId,
    jwt,
    refreshToken,
    expiresAt: jwtExpiresAt.toISOString(),
  };
}

async function issueTokenPair(userId: string, origin: NativeCredentialOrigin) {
  return db.transaction((transaction) => generateTokenPair(userId, transaction, origin));
}

function respondNativeAdmissionFailure(response: ServerResponse, error: unknown): boolean {
  if (error instanceof AuthSubjectDeniedError) {
    sendJson(response, 401, { error: 'Account is not available' });
    return true;
  }
  if (isAuthAdmissionUnavailable(error) || isNativeAuthInfrastructureFailure(error)) {
    sendJson(response, 503, { error: 'Authentication is temporarily unavailable' });
    return true;
  }
  return false;
}

/** Keep the reserved writers' existing infrastructure messages and safe logs. */
function respondReservedNativeAdmissionFailure(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AuthSubjectDeniedError) && !isAuthAdmissionUnavailable(error)) return false;
  return respondNativeAdmissionFailure(response, error);
}

// ---------------------------------------------------------------------------
// POST /auth/native/exchange
// ---------------------------------------------------------------------------

export async function handleNativeAuthExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { transferToken } = body as Record<string, unknown>;
  if (typeof transferToken !== 'string' || transferToken.length === 0) {
    sendJson(res, 400, { error: 'transferToken is required' });
    return;
  }

  // A reserved native capability has its own key, primary source admission,
  // durable one-shot receipt and qualified issuer transaction. It never enters
  // the legacy HMAC parser or its process/Redis replay cache.
  if (transferToken.startsWith(NATIVE_BROWSER_HANDOFF_PREFIX)) {
    try {
      const environment = Object.freeze({ ...process.env });
      if (browserBindingMode(environment) !== 'backend-staging') throw new AuthAdmissionUnavailableError();
      const qualification = currentStoreAuthorityConfiguration(environment);
      const result = await redeemNativeBrowserHandoff(
        () => getCredentialDatabase('private-native-handoff-v1'),
        qualification,
        transferToken,
        async (transaction, source, expiresAt, creation) => {
          const pair = await generateTokenPair(source.userId, transaction, {
            kind: 'transfer',
            generation: source.generation,
            authSessionId: source.authSessionId,
            authenticatedAt: source.authenticatedAt,
            requiresAccountCutoff: source.requiresAccountCutoff,
            capabilityExpiresAt: expiresAt.getTime(),
          });
          const accountCreation = creation ? parseAccountCreationReceipt(creation) : null;
          return {
            ...pair,
            ...(accountCreation && accountCreation.userId === source.userId ? { accountCreation } : {}),
          };
        },
        environment,
      );
      if (result.status === 'admitted') {
        sendJson(res, 200, result.result);
      } else {
        const status = { denied: 401, conflict: 409, unavailable: 503 }[result.status];
        sendJson(res, status, {
          error:
            result.status === 'unavailable' ? 'Authentication is temporarily unavailable' : 'Invalid transfer token',
        });
      }
    } catch (error) {
      if (!respondNativeAdmissionFailure(res, error))
        sendJson(res, 503, { error: 'Authentication is temporarily unavailable' });
    }
    return;
  }

  // Extract the signature before verification so we can check for replay
  const tokenParts = transferToken.split('.');
  if (tokenParts.length !== 2 || !tokenParts[1]) {
    sendJson(res, 401, { error: 'Invalid or expired transfer token' });
    return;
  }
  const tokenSignature = tokenParts[1];

  // Check if this transfer token has already been consumed (replay prevention)
  if (await isTokenConsumed(tokenSignature)) {
    logger.warn('[NativeAuth] Transfer token replay attempt detected');
    sendJson(res, 409, { error: 'Transfer token has already been used' });
    return;
  }

  // Verify the HMAC transfer token
  let verified: ReturnType<typeof verifyTransferToken>;
  try {
    verified = verifyTransferToken(transferToken);
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    throw error;
  }
  if (!verified) {
    logger.warn('[NativeAuth] Transfer token verification failed');
    sendJson(res, 401, { error: 'Invalid or expired transfer token' });
    return;
  }

  // Do not consume the one-shot transfer capability during a known authority
  // outage. The real issuer checks again under the user lock in its transaction.
  try {
    if (!(await isHumanSubjectActive(verified.userId))) {
      sendJson(res, 401, { error: 'Account is not available' });
      return;
    }
  } catch (error) {
    if (!respondNativeAdmissionFailure(res, error)) sendJson(res, 500, { error: 'Internal server error' });
    return;
  }

  // Atomically mark the token as consumed. If another request consumed it
  // between the EXISTS check above and now, markTokenConsumed returns 'replay'.
  const consumeResult = await markTokenConsumed(tokenSignature);
  if (consumeResult === 'replay') {
    logger.warn('[NativeAuth] Transfer token replay attempt detected (race)');
    sendJson(res, 409, { error: 'Transfer token has already been used' });
    return;
  }
  if (consumeResult === 'overloaded') {
    logger.error('[NativeAuth] Consumed token map full — rejecting request');
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }

  try {
    const tokenPair = await issueTokenPair(verified.userId, {
      kind: 'transfer',
      generation: verified.generation,
      authSessionId: verified.authSessionId,
      authenticatedAt: verified.authenticatedAt,
      requiresAccountCutoff: verified.requiresAccountCutoff,
      capabilityExpiresAt: verified.validUntil,
    });
    logger.info('[NativeAuth] Token exchange successful');
    sendJson(res, 200, {
      ...tokenPair,
      ...(verified.accountCreation ? { accountCreation: verified.accountCreation } : {}),
    });
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Token generation failed', { code: 'TOKEN_ISSUANCE_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/credentials
// ---------------------------------------------------------------------------

export async function handleNativeAuthCredentials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || email.length === 0 || typeof password !== 'string' || password.length === 0) {
    sendJson(res, 400, { error: 'email and password are required' });
    return;
  }

  try {
    const authenticatedUser = await authenticateIdentityPassword(db, email, password);
    if (!authenticatedUser) {
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }

    const authenticatedUserId = authenticatedUser.userId;
    // Issue only if the hash and generation bcrypt checked are still the
    // account's under the user lock: a check that passed just before a reset
    // must not mint a credential after it (BA-04 section 4).
    const tokenPair = await issueTokenPair(authenticatedUserId, {
      kind: 'sign-in',
      authenticatedAt: new Date(),
      passwordProof: {
        passwordHash: authenticatedUser.passwordHash,
        generation: authenticatedUser.generation,
        ...(authenticatedUser.authorityReceipt ? { authorityReceipt: authenticatedUser.authorityReceipt } : {}),
      },
    });
    logger.info('[NativeAuth] Credentials sign-in successful');
    const accountCreation = accountCreationReceipt(authenticatedUserId, false, 'email', authenticatedUser.createdAt);
    sendJson(res, 200, { ...tokenPair, ...(accountCreation ? { accountCreation } : {}) });
  } catch (error) {
    if (error instanceof PasswordProofStaleError) {
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Credentials sign-in failed', { code: 'PASSWORD_SIGNIN_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/register — create a Boardsesh account from the mobile app
//
// Mirrors the web register route (packages/web/app/api/auth/register/route.ts):
// it creates the same users + userCredentials + userProfiles rows. The
// difference is that on success we mint a mobile JWT pair and return it, so the
// app logs the user straight in (no web browser, no email round-trip) — the same
// auto-login behaviour the native OAuth and credentials handlers already have.
//
// Email verification: this adapter does not deliver verification email, and
// handleNativeAuthCredentials never checks emailVerified, so the new user is
// auto-logged-in on the device regardless. We still honour
// EMAIL_VERIFICATION_ENABLED for the stored emailVerified value, mirroring the
// web register route: when the flag is on, accounts are created UNVERIFIED
// (emailVerified: null) so this native path can't mint verified accounts for
// arbitrary emails and thereby bypass web's verification gate
// (auth-options.ts blocks unverified credentials login when the flag is on).
// When the flag is off (the default), accounts are created verified.
// ---------------------------------------------------------------------------

export async function handleNativeAuthRegister(
  req: IncomingMessage,
  res: ServerResponse,
  database: DbInstance = db,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const validation = parseCurrentStorePasswordRegistration(body as Record<string, unknown>);
  if (!validation.ok) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  let configuration: ReturnType<typeof currentStoreNativeRegistrationConfiguration>;
  try {
    configuration = currentStoreNativeRegistrationConfiguration();
  } catch {
    logger.warn('[NativeAuth] Reserved registration unavailable', { category: 'configuration' });
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  if (configuration.mode === 'reserved-staging') {
    await handleReservedNativeRegistration(res, database, configuration.authority, validation.registration);
    return;
  }

  try {
    await database.transaction(assertLegacyIdentityWriterAllowed);
    const prepared = await prepareCurrentStorePasswordRegistration(database, validation.registration);
    if (!prepared) {
      sendJson(res, 409, {
        error: 'An account with this email already exists. Please sign in with your existing account.',
      });
      return;
    }

    // Mirror web: unverified when the verification gate is on, verified otherwise.
    const emailVerificationEnabled = process.env.EMAIL_VERIFICATION_ENABLED === 'true';

    const origin = signedInNow();
    const result = await database.transaction(async (tx) => {
      const identity = await insertCurrentStorePasswordIdentity(tx, prepared, emailVerificationEnabled);
      const tokenPair = await generateTokenPair(identity.userId, tx, origin);
      await assertLegacyIdentityWriterAllowed(tx);
      return {
        userId: identity.userId,
        tokenPair,
        accountCreation: accountCreationReceipt(identity.userId, true, 'email', identity.createdAt),
      };
    });

    logger.info('[NativeAuth] Registration successful');
    sendJson(res, 201, { ...result.tokenPair, accountCreation: result.accountCreation });
  } catch (error) {
    // Race: a concurrent request created this email between the pre-check and
    // insert. PostgreSQL unique-violation code is '23505'. NOTE: users.email has
    // no unique index today, so this won't fire from the email column yet — the
    // pre-check above is the real guard. The handler stays correct once a
    // uniqueIndex on lower-cased users.email is added (tracked as follow-up).
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      sendJson(res, 409, { error: 'An account with this email already exists' });
      return;
    }
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Registration failed', { code: 'REGISTRATION_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

const nativeAuthDriverCodes = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isNativeAuthInfrastructureFailure(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return (
    error instanceof CurrentStoreFoundationError ||
    error instanceof DrizzleQueryError ||
    (code !== undefined && (/^[0-9A-Z]{5}$/.test(code) || nativeAuthDriverCodes.has(code)))
  );
}

async function handleReservedNativeRegistration(
  response: ServerResponse,
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  registration: Parameters<typeof prepareCurrentStorePasswordRegistration>[1],
) {
  const configuredAuthority = { ...authorityInput };
  const capturedRegistration = { ...registration };
  try {
    // Validate authority before even an exact-email precheck can report409.
    // Bcrypt remains outside the global manifest's locked transaction.
    const receipt = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      return captureIdentityAuthority(transaction, configuredAuthority);
    });
    const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
    const prepared = await prepareCurrentStorePasswordRegistration(database, capturedRegistration);
    const origin = signedInNow();
    const result = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const inserted = await insertReservedPasswordIdentity(
        transaction,
        authority,
        {
          email: capturedRegistration.email,
          prepared,
          emailVerificationEnabled: authority.emailVerificationEnabled,
        },
        receipt,
      );
      if (inserted.outcome === 'exists') return inserted;
      const { identity } = inserted;
      // This remains the installed native issuer, bound to the identity's tx.
      const tokenPair = await generateTokenPair(identity.userId, transaction, origin);
      await revalidateIdentityAuthority(transaction, receipt);
      return {
        outcome: 'created' as const,
        tokenPair,
        accountCreation: accountCreationReceipt(identity.userId, true, 'email', identity.createdAt),
      };
    });
    if (result.outcome === 'exists') {
      sendJson(response, 409, {
        error: 'An account with this email already exists. Please sign in with your existing account.',
      });
      return;
    }
    logger.info('[NativeAuth] Reserved registration successful', { category: 'created' });
    sendJson(response, 201, { ...result.tokenPair, accountCreation: result.accountCreation });
  } catch (error) {
    if (respondReservedNativeAdmissionFailure(response, error)) return;
    const unavailable = isNativeAuthInfrastructureFailure(error);
    // Never pass the original query/error/cause/parameters into logs or Sentry.
    // This branch returns before the unchanged legacy raw-error handler.
    if (unavailable) {
      logger.warn('[NativeAuth] Reserved registration unavailable', { category: 'authority-or-database' });
      sendJson(response, 503, { error: 'Service temporarily unavailable' });
    } else {
      logger.error('[NativeAuth] Reserved registration failed', new Error('Native registration internal failure'));
      sendJson(response, 500, { error: 'Internal server error' });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/oauth — native Sign in with Apple / Google
//
// The mobile app runs the native provider flow (expo-apple-authentication /
// @react-native-google-signin) and posts the provider's identity token here.
// We verify the token against the provider's JWKS, then find-or-create the
// Boardsesh user and issue our own mobile JWT pair. Account linking is by the
// provider's stable `sub`. Legacy mode retains its email-link fallback;
// explicitly staged resolution reserves new keys and rejects email-only links.
// ---------------------------------------------------------------------------

/** Apple's bundle identifier — the `aud` claim on Apple identity tokens. */
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? 'com.boardsesh.app';

/** Apple's issuer for Sign in with Apple identity tokens. */
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Google accepts two issuer spellings on its ID tokens. Both are valid and
 * which one appears depends on the signing key / rollout.
 */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Module-level JWKS singletons. `createRemoteJWKSet` returns a function that
// caches the fetched keys internally and only re-fetches on key rotation, so
// constructing these once (not per-request) is the documented pattern.
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

type ForwardedName = { firstName?: string; lastName?: string };

/**
 * The identity claims we trust from a verified provider token. `sub` is the
 * provider's stable per-user id (used for account linking); `email` may be
 * absent on Apple resubmissions (handled by the sub lookup).
 */
type NativeOAuthVerification =
  | { status: 'verified'; identity: VerifiedOAuthIdentity }
  | { status: 'invalid' }
  | { status: 'unavailable' };

const invalidNativeOAuthCodes = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
]);

/** JWT payload typings do not validate an arbitrary runtime subject. */
function validStagedNativeSubject(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.trim().length > 0 && Buffer.byteLength(subject, 'utf8') <= 1024;
}

/**
 * The configured Google OAuth client IDs. Any of the iOS / Android / Web
 * client IDs is an accepted `aud` because @react-native-google-signin issues
 * ID tokens whose audience is the *webClientId*, while a raw native flow can
 * produce a platform-client audience.
 */
function getGoogleAudiences(): string[] {
  return [
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
  ].filter((clientId): clientId is string => typeof clientId === 'string' && clientId.length > 0);
}

/**
 * Best-effort nonce check, enforced only when the client supplies a `nonce`.
 * Apple echoes the request nonce into the token's `nonce` claim verbatim
 * (expo-apple-authentication passes it unmodified), so the client SHA-256-hashes
 * the nonce before handing it to Apple and sends us the raw value: the token
 * carries `SHA-256(raw)` and we re-hash to compare, so the raw nonce never lives
 * in the token. We also accept a verbatim match as a fallback for a client that
 * forwards the nonce unhashed. The JWT signature/audience is the real
 * authentication boundary; the nonce only ties a token to this sign-in attempt
 * (and is unenforced when omitted, e.g. Google's native SDK sends none).
 */
function verifyNonce(rawNonce: string | undefined, payloadNonce: unknown): boolean {
  if (!rawNonce) return true;
  if (typeof payloadNonce !== 'string' || payloadNonce.length === 0) return false;
  const hashedNonce = crypto.createHash('sha256').update(rawNonce).digest('hex');
  return payloadNonce === hashedNonce || payloadNonce === rawNonce;
}

/**
 * Verify a provider identity token against the provider's JWKS and extract the
 * claims we need. Staging separates authoritative invalid-token failures from
 * required-key/configuration uncertainty and logs only fixed categories.
 * Legacy callers retain the current failure response and diagnostics.
 */
async function verifyProviderIdentityToken(
  provider: OAuthProvider,
  identityToken: string,
  nonce?: string,
  staged = false,
): Promise<NativeOAuthVerification> {
  try {
    if (provider === 'apple') {
      if (staged && !APPLE_BUNDLE_ID.trim()) {
        logger.warn('[NativeAuth] OAuth verification unavailable', { category: 'provider-configuration' });
        return { status: 'unavailable' };
      }
      const { payload } = await jwtVerify(identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: APPLE_BUNDLE_ID,
        // Both providers sign id tokens with RS256; pin it so a future JWKS that
        // also advertises a weaker/asymmetric-confusable alg can't be selected.
        algorithms: ['RS256'],
        clockTolerance: 60,
        ...(staged ? { requiredClaims: ['exp'] } : {}),
      });
      if (!payload.sub || (staged && !validStagedNativeSubject(payload.sub)) || !verifyNonce(nonce, payload.nonce))
        return { status: 'invalid' };
      return {
        status: 'verified',
        identity: {
          sub: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : null,
          emailVerified: payload.email_verified === true || payload.email_verified === 'true',
          // Apple never returns the name in the token — it's delivered once, in
          // the authorization response, and forwarded by the client separately.
          name: null,
        },
      };
    }

    const audiences = getGoogleAudiences();
    if (audiences.length === 0) {
      if (staged) logger.warn('[NativeAuth] OAuth verification unavailable', { category: 'provider-configuration' });
      else logger.error('[NativeAuth] No Google client IDs configured — cannot verify Google token');
      return { status: staged ? 'unavailable' : 'invalid' };
    }
    const { payload } = await jwtVerify(identityToken, googleJwks, {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ['RS256'],
      clockTolerance: 60,
      ...(staged ? { requiredClaims: ['exp'] } : {}),
    });
    if (!payload.sub || (staged && !validStagedNativeSubject(payload.sub)) || !verifyNonce(nonce, payload.nonce))
      return { status: 'invalid' };
    return {
      status: 'verified',
      identity: {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: typeof payload.name === 'string' ? payload.name : null,
      },
    };
  } catch (error) {
    if (staged) {
      const code = getPostgresErrorCode(error);
      const status = code !== undefined && invalidNativeOAuthCodes.has(code) ? 'invalid' : 'unavailable';
      logger.warn('[NativeAuth] OAuth verification rejected', {
        category: status === 'invalid' ? 'invalid-token' : 'provider-unavailable',
      });
      return { status };
    }
    logger.warn('[NativeAuth] OAuth identity token verification failed', { code: 'OAUTH_PROOF_REJECTED' });
    return { status: 'invalid' };
  }
}

/** Narrow an unknown `name` field from the request body to ForwardedName. */
function parseForwardedName(value: unknown): ForwardedName | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { firstName, lastName } = value as Record<string, unknown>;
  const forwarded: ForwardedName = {};
  if (typeof firstName === 'string') forwarded.firstName = firstName;
  if (typeof lastName === 'string') forwarded.lastName = lastName;
  return forwarded.firstName !== undefined || forwarded.lastName !== undefined ? forwarded : undefined;
}

type FindOrCreateResult =
  | {
      status: 'ok';
      tokenPair: Awaited<ReturnType<typeof generateTokenPair>>;
      userId: string;
      accountCreation?: AccountCreationReceipt;
    }
  | { status: 'no_email' }
  | { status: 'conflict' };

/**
 * Resolve the Boardsesh user for a verified identity and mint a token pair,
 * all inside one transaction:
 *   1. Existing `accounts` row for (provider, sub) → that user.
 *   2. Else the one `users` row the email names under the BA-02 rule (stored
 *      exactly as the normalized address, else the single row storing it in
 *      other capitals) → link it (insert the accounts row; mark email verified
 *      when the provider asserts it).
 *   3. Else, when no row holds the address in any capitalisation, create the
 *      user + profile + accounts link, storing the normalized address.
 * An address that is taken but names no single linkable account (several
 * capitalisations, two rows with the same text, or an unverified provider
 * email) is a conflict: no link and no new account. Apple resubmissions omit the email but always resolve via step 1.
 */
async function findOrCreateOAuthUser(
  provider: OAuthProvider,
  identity: VerifiedOAuthIdentity,
  forwardedName: ForwardedName | undefined,
  origin: NativeCredentialOrigin,
  database: DbInstance = db,
): Promise<FindOrCreateResult> {
  // This legacy auto-link writer lacks the staged gate/reservation protocol.
  // Refuse it even when called directly rather than through the mode parser.
  if (identityMirrorMode() === 'on') throw new Error('AUTH_IDENTITY_MIRROR refuses legacy native OAuth writes');
  return database.transaction(async (tx) => {
    await transactionSettings(tx);
    await assertLegacyIdentityWriterAllowed(tx);
    // 1. Link by the provider's stable subject id.
    const linkedRows = await tx
      .select({ userId: accounts.userId, createdAt: users.createdAt })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.userId))
      .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub)))
      .limit(1);
    const linked = linkedRows[0];
    if (linked) {
      const tokenPair = await generateTokenPair(linked.userId, tx, origin);
      return {
        status: 'ok',
        tokenPair,
        userId: linked.userId,
        accountCreation: accountCreationReceipt(linked.userId, false, provider, linked.createdAt),
      };
    }

    const normalizedEmail = identity.email ? normalizeAccountEmail(identity.email) : null;
    const holders = normalizedEmail ? await findAccountHoldersByEmail(tx, normalizedEmail) : null;

    // 2. Link by email — ONLY when the provider asserts the email is verified.
    // This is the security boundary NextAuth's allowDangerousEmailAccountLinking
    // leaves to the provider: auto-linking an *unverified* provider email to an
    // existing account would let anyone able to mint a token for an arbitrary
    // email claim take over that account. Apple always verifies (real or relay);
    // Google's email_verified is almost always true.
    const matched = holders && identity.emailVerified ? soleAccount(holders) : null;
    if (matched) {
      await transactionSettings(tx);
      await requireHumanSubjectForIssuance(tx, matched.id);
      await tx
        .insert(accounts)
        .values({ userId: matched.id, type: 'oauth', provider, providerAccountId: identity.sub })
        .onConflictDoNothing();
      // The insert does nothing when a concurrent sign-in linked this subject
      // first. Confirm who owns the link now; never mint for an unconfirmed owner.
      const [link] = await tx
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub)))
        .limit(1);
      if (link?.userId !== matched.id) return { status: 'conflict' };
      if (!matched.emailVerified) {
        await tx.update(users).set({ emailVerified: new Date() }).where(eq(users.id, matched.id));
      }
      const tokenPair = await generateTokenPair(matched.id, tx, origin);
      return {
        status: 'ok',
        tokenPair,
        userId: matched.id,
        accountCreation: accountCreationReceipt(matched.id, false, provider, matched.createdAt),
      };
    }

    // The address is taken but names no single account to link (several
    // capitalisations, two rows with the same text, or an unverified provider
    // email): another account for it would add to a shared address.
    if (holders && holders.kind !== 'none') return { status: 'conflict' };

    // 3. Create. Email is NOT NULL on `users`; Apple/Google both return an
    // email on first authorization (Apple's relay address when hidden), so a
    // brand-new sub without an email is unexpected — reject rather than
    // fabricate one.
    if (!normalizedEmail) {
      return { status: 'no_email' };
    }

    const newUserId = crypto.randomUUID();
    const createdAt = new Date();
    await tx.insert(users).values({
      id: newUserId,
      createdAt,
      email: normalizedEmail,
      name: resolveDisplayName(identity, forwardedName),
      emailVerified: identity.emailVerified ? new Date() : null,
    });
    // Mirror the web `createUser` event: every user gets a profile row. New
    // accounts start public (the column defaults); Private is opt-in.
    await tx.insert(userProfiles).values({ userId: newUserId }).onConflictDoNothing();
    await tx.insert(accounts).values({ userId: newUserId, type: 'oauth', provider, providerAccountId: identity.sub });
    const tokenPair = await generateTokenPair(newUserId, tx, origin);
    return {
      status: 'ok',
      tokenPair,
      userId: newUserId,
      accountCreation: accountCreationReceipt(newUserId, true, provider, createdAt),
    };
  });
}

export async function handleNativeAuthOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  database: DbInstance = db,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { provider, identityToken, nonce, name } = body as Record<string, unknown>;

  if (provider !== 'apple' && provider !== 'google') {
    sendJson(res, 400, { error: 'provider must be "apple" or "google"' });
    return;
  }
  if (typeof identityToken !== 'string' || identityToken.length === 0) {
    sendJson(res, 400, { error: 'identityToken is required' });
    return;
  }
  if (nonce !== undefined && typeof nonce !== 'string') {
    sendJson(res, 400, { error: 'nonce must be a string' });
    return;
  }

  let configuration: ReturnType<typeof currentStoreNativeOAuthConfiguration>;
  try {
    configuration = currentStoreNativeOAuthConfiguration();
  } catch {
    logger.warn('[NativeAuth] Reserved OAuth unavailable', { category: 'configuration' });
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  const staged = configuration.mode === 'reserved-staging';
  let receipt: IdentityAuthorityReceipt | undefined;
  if (configuration.mode === 'reserved-staging') {
    try {
      receipt = await database.transaction(async (transaction) => {
        await transactionSettings(transaction);
        return captureIdentityAuthority(transaction, configuration.authority);
      });
    } catch (error) {
      reportReservedNativeOAuthFailure(res, error);
      return;
    }
  }
  const verified = await verifyProviderIdentityToken(provider, identityToken, nonce, staged);
  if (verified.status === 'invalid') {
    sendJson(res, 401, { error: 'Invalid or expired identity token' });
    return;
  }
  if (verified.status === 'unavailable') {
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  const { identity } = verified;
  const origin = signedInNow();
  if (configuration.mode === 'reserved-staging') {
    if (!receipt) {
      reportReservedNativeOAuthFailure(res, new CurrentStoreFoundationError('STALE_AUTHORITY'));
      return;
    }
    await handleReservedNativeOAuth(
      res,
      database,
      configuration.authority,
      provider,
      identity,
      parseForwardedName(name),
      origin,
      receipt,
    );
    return;
  }

  try {
    const result = await findOrCreateOAuthUser(provider, identity, parseForwardedName(name), origin, database);
    if (result.status === 'no_email') {
      logger.warn(`[NativeAuth] ${provider} sign-in for a new account without an email — rejecting`);
      sendJson(res, 401, { error: 'An email is required to create an account' });
      return;
    }
    if (result.status === 'conflict') {
      logger.warn(`[NativeAuth] ${provider} sign-in names no single account for its email — rejecting`);
      sendJson(res, 409, {
        error: 'This sign-in method is not linked to that account. Use your existing sign-in method.',
      });
      return;
    }
    logger.info('[NativeAuth] Provider sign-in successful', { provider });
    sendJson(res, 200, {
      ...result.tokenPair,
      ...(result.accountCreation ? { accountCreation: result.accountCreation } : {}),
    });
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] OAuth sign-in failed', { code: 'OAUTH_SIGNIN_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

function reportReservedNativeOAuthFailure(response: ServerResponse, error: unknown) {
  if (respondReservedNativeAdmissionFailure(response, error)) return;
  if (isNativeAuthInfrastructureFailure(error)) {
    logger.warn('[NativeAuth] Reserved OAuth unavailable', { category: 'authority-or-database' });
    sendJson(response, 503, { error: 'Service temporarily unavailable' });
  } else {
    logger.error('[NativeAuth] Reserved OAuth failed', new Error('Native OAuth internal failure'));
    sendJson(response, 500, { error: 'Internal server error' });
  }
}

async function handleReservedNativeOAuth(
  response: ServerResponse,
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  provider: OAuthProvider,
  identity: VerifiedOAuthIdentity,
  name: ForwardedName | undefined,
  origin: NativeCredentialOrigin,
  receiptInput: IdentityAuthorityReceipt,
) {
  const receipt = Object.freeze({ ...receiptInput });
  const authority = { ...authorityInput, expectedWriterEpoch: receipt.epoch };
  try {
    const result = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      await revalidateIdentityAuthority(transaction, receipt);
      const resolved = await resolveReservedNativeOAuthIdentity(
        transaction,
        authority,
        provider,
        identity,
        name,
        receipt,
      );
      await revalidateIdentityAuthority(transaction, receipt);
      if (resolved.outcome !== 'linked' && resolved.outcome !== 'created') return resolved;
      const tokenPair = await generateTokenPair(resolved.userId, transaction, origin);
      await revalidateIdentityAuthority(transaction, receipt);
      return {
        outcome: 'ok' as const,
        tokenPair,
        accountCreation: accountCreationReceipt(
          resolved.userId,
          resolved.outcome === 'created',
          provider,
          resolved.createdAt,
        ),
      };
    });
    if (result.outcome === 'conflict') {
      sendJson(response, 409, {
        error: 'This sign-in method is not linked to that account. Use your existing sign-in method.',
      });
    } else if (result.outcome === 'no_email') {
      sendJson(response, 401, { error: 'An email is required to create an account' });
    } else if (result.outcome === 'deleted') {
      sendJson(response, 401, { error: 'Account is not available' });
    } else {
      sendJson(response, 200, {
        ...result.tokenPair,
        ...(result.accountCreation ? { accountCreation: result.accountCreation } : {}),
      });
    }
  } catch (error) {
    reportReservedNativeOAuthFailure(response, error);
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/refresh
// ---------------------------------------------------------------------------

export async function handleNativeAuthRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    sendJson(res, 400, { error: 'refreshToken is required' });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  // Throttle known digests before database work, without charging devices behind
  // one proxy to a shared IP bucket. A new digest must first be classified by a
  // non-locking lookup: arbitrary missing secrets cannot fill client capacity.
  const bucketKey = `refresh:${tokenHash}`;
  const existingBuckets = refreshRateLimitMap.has(bucketKey)
    ? refreshRateLimitMap
    : invalidRefreshRateLimitMap.has(bucketKey)
      ? invalidRefreshRateLimitMap
      : undefined;
  if (existingBuckets && respondRefreshRateLimit(res, checkAuthRateLimit(bucketKey, existingBuckets))) {
    return;
  }

  let result:
    | { status: 401; error: string }
    | { status: 200; tokenPair: Awaited<ReturnType<typeof generateTokenPair>> };
  try {
    // A non-locking hint is not token admission. Acquire the user lock before
    // touching refresh rows, then recheck the exact hash/UID and current state.
    const [hint] = await db
      .select({ userId: mobileRefreshTokens.userId })
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (
      !existingBuckets &&
      respondRefreshRateLimit(
        res,
        checkAuthRateLimit(bucketKey, hint ? refreshRateLimitMap : invalidRefreshRateLimitMap),
      )
    ) {
      return;
    }
    if (!hint) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }
    result = await db.transaction(async (tx) => {
      await transactionSettings(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      // The user lock first, then the generations in a statement of its own. A
      // reset or deletion that committed while this waited is seen here, and none
      // can commit before this does: each takes users FOR UPDATE, which this
      // KEY SHARE excludes. The parent is decided against these generations.
      const lockedState = await requireHumanSubjectForIssuance(tx, hint.userId);
      // Atomically revoke the token and return it in a single query.
      // This prevents TOCTOU races: if two concurrent requests present the same
      // refresh token, only one will get the row back — the other gets an empty
      // result because the WHERE clause requires revoked_at IS NULL.
      const revokedRows = await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mobileRefreshTokens.tokenHash, tokenHash),
            eq(mobileRefreshTokens.userId, hint.userId),
            isNull(mobileRefreshTokens.revokedAt),
          ),
        )
        .returning();

      const revokedToken = revokedRows[0];
      if (!revokedToken) {
        return { status: 401 as const, error: 'Invalid refresh token' };
      }

      if (revokedToken.expiresAt < new Date()) {
        return { status: 401 as const, error: 'Refresh token expired' };
      }

      const tokenPair = await generateTokenPair(
        revokedToken.userId,
        tx,
        { kind: 'refresh', parent: revokedToken },
        lockedState,
      );
      return { status: 200 as const, tokenPair };
    });
  } catch (error) {
    // These typed refusals originate inside the transaction and roll it back.
    if (error instanceof AuthSubjectDeniedError || isAuthAdmissionUnavailable(error)) {
      respondNativeAdmissionFailure(res, error);
      return;
    }
    // A lost COMMIT acknowledgement can leave the rotation outcome unknown.
    // Keep this body distinct from the known pre-consumption admission refusal;
    // updated watches must not infer that an uncertain secret is safe to reuse.
    logger.warn('[NativeAuth] Token refresh unavailable');
    sendJson(res, 503, { error: 'Token refresh is temporarily unavailable' });
    return;
  }

  // Publication happens after commit, outside the rollback/unavailable catch.
  if (result.status !== 200) {
    sendJson(res, result.status, { error: result.error });
    return;
  }
  logger.info('[NativeAuth] Token refresh successful');
  sendJson(res, 200, result.tokenPair);
}

// ---------------------------------------------------------------------------
// POST /auth/native/revoke
// ---------------------------------------------------------------------------

export async function handleNativeAuthRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // No rate limiting for revoke — the endpoint requires a valid refresh token
  // (a secret), so it's already gated. Exempting it prevents aggressive retry
  // loops from locking a user out of sign-out.

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    sendJson(res, 400, { error: 'refreshToken is required' });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  try {
    const matchedToken = await revokeNativeCredentials(db, tokenHash, currentNativeRevocationMode());
    if (!matchedToken) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }

    logger.info('[NativeAuth] Native credentials revoked');
    sendJson(res, 200, { revoked: true });
  } catch (error) {
    if (error instanceof AuthSubjectDeniedError) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }
    logger.error('[NativeAuth] Token revocation failed', { code: 'NATIVE_REVOCATION_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Watch pairing — POST /api/watch/pair-code (authed) + POST /api/watch/pair
//
// A Garmin watch (Connect IQ) can only make plain HTTPS requests and has no
// good text entry, so it can't run the web OAuth transfer-token dance. Instead:
//   1. The already-logged-in phone/web app calls POST /api/watch/pair-code and
//      shows the returned short code to the user.
//   2. The user types the code on the watch, which POSTs /api/watch/pair to
//      exchange it for the same { jwt, refreshToken, expiresAt } mobile token
//      pair every other native client uses (generateTokenPair).
//
// The code lives in Redis with a short TTL and is single-use (GETDEL on
// consume). It must be cross-instance (the phone and watch may hit different
// backend instances), so pairing requires Redis — no in-memory fallback.
// ---------------------------------------------------------------------------

/** Pairing-code lifetime — long enough to read off a phone and type on a watch. */
const WATCH_PAIR_CODE_TTL_SECONDS = WATCH_PAIR_CAPABILITY_TTL_SECONDS;

/** Pairing-code length in characters. */
const WATCH_PAIR_CODE_LENGTH = 8;

/**
 * Unambiguous alphabet for hand entry on a watch: A–Z minus I/L/O/U and digits
 * 2–9 (no 0/1). 30^8 ≈ 2^39 combinations — with the 300s TTL, single-use
 * consume, and the IP rate limit, brute-forcing a live code is infeasible.
 */
const WATCH_PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Redis key prefix for live pairing codes. */
const WATCH_PAIR_CODE_REDIS_PREFIX = 'boardsesh:watch:pair:';

/** How many times to retry on the (astronomically unlikely) code collision. */
const WATCH_PAIR_CODE_MAX_ATTEMPTS = 5;

function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < WATCH_PAIR_CODE_LENGTH; i++) {
    code += WATCH_PAIR_CODE_ALPHABET[crypto.randomInt(WATCH_PAIR_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * POST /api/watch/pair-code
 * Headers: Authorization: Bearer <token>  (web NextAuth JWE or mobile JWS)
 * Body: none
 *
 * Mints a short, single-use pairing code bound to the authenticated user and
 * returns { code, expiresAt }. Called by the phone/web "Pair a Garmin watch"
 * UI, so it accepts either token family via validateToken.
 */
export async function handleWatchPairCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  const authHeader = req.headers['authorization'];
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  const token = headerValue.slice(7).trim();
  const pairingEnvironment = { ...process.env };
  let mode: ReturnType<typeof watchPairingMode>;
  try {
    mode = watchPairingMode(pairingEnvironment);
  } catch {
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  const admission = token ? await validateHttpAuthToken(token, res) : { available: true as const, auth: null };
  if (!admission.available) return;
  const auth = admission.auth;
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (!redisClientManager.isRedisConnected()) {
    // Pairing codes must be readable across instances; without Redis a code
    // minted on one instance couldn't be consumed on another.
    logger.error('[WatchPair] Redis unavailable — cannot mint pairing code');
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    if (mode === 'legacy') await preflightLegacyPairing(auth.userId);
    const bound =
      mode === 'source-bound-staging'
        ? await createWatchPairCapability(auth, token, pairingEnvironment.NEXTAUTH_SECRET ?? '')
        : null;
    if (mode === 'source-bound-staging' && !bound) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const contents = bound?.contents ?? auth.userId;
    const ttlSeconds = bound?.ttlSeconds ?? WATCH_PAIR_CODE_TTL_SECONDS;
    let code: string | null = null;
    for (let attempt = 0; attempt < WATCH_PAIR_CODE_MAX_ATTEMPTS; attempt++) {
      const candidate = generatePairingCode();
      // SET NX so a rare collision with a live code doesn't overwrite it.
      if (bound && bound.capability.expiresAt <= Date.now()) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      const stored = bound
        ? await publisher.set(
            `${WATCH_PAIR_CODE_REDIS_PREFIX}${candidate}`,
            contents,
            'PXAT',
            bound.capability.expiresAt,
            'NX',
          )
        : await publisher.set(`${WATCH_PAIR_CODE_REDIS_PREFIX}${candidate}`, contents, 'EX', ttlSeconds, 'NX');
      if (bound && bound.capability.expiresAt <= Date.now()) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (stored === 'OK') {
        code = candidate;
        break;
      }
    }

    if (!code) {
      logger.error('[WatchPair] Failed to allocate a unique pairing code after retries');
      sendJson(res, 503, { error: 'Service temporarily overloaded' });
      return;
    }

    const expiresAt = new Date(bound?.capability.expiresAt ?? Date.now() + ttlSeconds * 1000).toISOString();
    logger.info('[WatchPair] Issued pairing code');
    sendJson(res, 200, { code, expiresAt });
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[WatchPair] Failed to issue pairing code', { code: 'WATCH_CODE_ISSUANCE_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

/**
 * POST /api/watch/pair
 * Body: { code: string }
 *
 * Consumes a pairing code (single-use) and returns a mobile token pair for the
 * user the code was minted for. Unauthenticated — the code is the credential.
 */
export async function handleWatchPair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  const pairingEnvironment = { ...process.env };
  let staged: boolean;
  try {
    staged =
      watchPairingMode(pairingEnvironment) === 'source-bound-staging' ||
      parseNativeRevocationMode(pairingEnvironment) === 'generation';
  } catch {
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { code } = body as Record<string, unknown>;
  if (typeof code !== 'string' || code.length === 0) {
    sendJson(res, 400, { error: 'code is required' });
    return;
  }

  // Normalize hand entry: strip separators/whitespace, uppercase. A correct
  // code is exactly WATCH_PAIR_CODE_LENGTH alphanumerics after normalization.
  const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length !== WATCH_PAIR_CODE_LENGTH) {
    sendJson(res, 400, { error: 'Invalid pairing code' });
    return;
  }

  if (!redisClientManager.isRedisConnected()) {
    logger.error('[WatchPair] Redis unavailable — cannot consume pairing code');
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const pendingContents = await publisher.get(`${WATCH_PAIR_CODE_REDIS_PREFIX}${normalized}`);
    const capability = pendingContents ? parseWatchPairCapability(pendingContents) : null;
    const legacyUserId =
      pendingContents && !pendingContents.startsWith('{') && !staged && pendingContents.length <= 256
        ? pendingContents
        : null;
    const pendingUserId = capability?.userId ?? legacyUserId;
    if (!pendingContents || !pendingUserId || !(await isHumanSubjectActive(pendingUserId))) {
      sendJson(res, 401, { error: 'Invalid or expired pairing code' });
      return;
    }
    // Admission awaited the primary. An expired/replaced code must not let
    // this older request consume a newer owner's capability at the same key.
    let userId: unknown;
    try {
      userId = await publisher.eval(
        "local owner = redis.call('GET', KEYS[1]); if owner == ARGV[1] then redis.call('DEL', KEYS[1]); return owner end; return false",
        1,
        `${WATCH_PAIR_CODE_REDIS_PREFIX}${normalized}`,
        pendingContents,
      );
    } catch {
      // Redis errors can retain command arguments. Keep them out of logs and
      // never restore a claim after an uncertain atomic command outcome.
      throw new AuthAdmissionUnavailableError();
    }
    if (!userId || userId !== pendingContents) {
      sendJson(res, 401, { error: 'Invalid or expired pairing code' });
      return;
    }

    // Redis consumption is terminal even if the primary rejects this source.
    // Never restore a capability after a denied or uncertain mint.
    const tokenPair = await issueTokenPair(
      pendingUserId,
      capability
        ? {
            kind: 'transfer',
            generation: capability.source.generation,
            authSessionId: capability.source.authSessionId,
            authenticatedAt:
              capability.source.authenticatedAt === null ? null : new Date(capability.source.authenticatedAt * 1000),
            requiresAccountCutoff: capability.source.requiresAccountCutoff,
            ...(capability.source.kind === 'native' ? { nativeGeneration: capability.source.nativeGeneration } : {}),
            capabilityExpiresAt: capability.expiresAt,
          }
        : LEGACY_PAIRING_WITHOUT_SOURCE,
    );
    logger.info('[WatchPair] Pairing successful');
    sendJson(res, 200, tokenPair);
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[WatchPair] Pairing failed', { code: 'WATCH_PAIRING_FAILED' });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup of expired / revoked refresh tokens
// ---------------------------------------------------------------------------

/** How often to run the cleanup (every 6 hours). */
const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Revoked tokens older than this are deleted (7 days). */
const REVOKED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let refreshTokenCleanupHandle: ReturnType<typeof setInterval> | null = null;

async function runRefreshTokenCleanup(): Promise<void> {
  try {
    const removedCount = await cleanupNativeRefreshRows(db);
    if (removedCount > 0) {
      logger.info(`[NativeAuth Cleanup] Removed ${String(removedCount)} expired/revoked refresh token(s)`);
    }
  } catch {
    logger.error('[NativeAuth Cleanup] Failed to remove expired refresh tokens', { code: 'REFRESH_CLEANUP_FAILED' });
  }
}

/** Start the periodic refresh token cleanup loop. */
export function startRefreshTokenCleanup(): void {
  if (refreshTokenCleanupHandle !== null) return;
  logger.info(
    `[NativeAuth Cleanup] Started (interval=${String(REFRESH_TOKEN_CLEANUP_INTERVAL_MS)}ms, ` +
      `revokedRetention=${String(REVOKED_TOKEN_RETENTION_MS / (24 * 60 * 60 * 1000))}d)`,
  );

  // Run once shortly after startup, then on the regular interval.
  const initialDelay = setTimeout(() => {
    runRefreshTokenCleanup().catch(() => {
      logger.error('[NativeAuth Cleanup] Initial tick failed', { code: 'REFRESH_CLEANUP_INITIAL_FAILED' });
    });
  }, 60 * 1000);
  if (typeof initialDelay.unref === 'function') initialDelay.unref();

  refreshTokenCleanupHandle = setInterval(() => {
    runRefreshTokenCleanup().catch(() => {
      logger.error('[NativeAuth Cleanup] Tick failed', { code: 'REFRESH_CLEANUP_TICK_FAILED' });
    });
  }, REFRESH_TOKEN_CLEANUP_INTERVAL_MS);

  if (typeof refreshTokenCleanupHandle.unref === 'function') refreshTokenCleanupHandle.unref();
}

export function stopRefreshTokenCleanup(): void {
  if (refreshTokenCleanupHandle === null) return;
  clearInterval(refreshTokenCleanupHandle);
  refreshTokenCleanupHandle = null;
  logger.info('[NativeAuth Cleanup] Stopped');
}

// ---------------------------------------------------------------------------
// Test-only utilities
// ---------------------------------------------------------------------------

/** Reset the in-memory rate limit and consumed token maps. Test-only. */
export function __resetNativeAuthStateForTests(): void {
  authRateLimitMap.clear();
  refreshRateLimitMap.clear();
  invalidRefreshRateLimitMap.clear();
  invalidRefreshCapacityRetryAt = 0;
  consumedTransferTokens.clear();
}

/** Fill the consumed-token map with fresh entries for capacity testing. Test-only. */
export function __fillConsumedTokenMapForTests(count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    consumedTransferTokens.set(`test-sig-${String(i)}`, now);
  }
}

/** Fill the rate-limit map with non-expired entries for capacity testing. Test-only. */
export function __fillRateLimitMapForTests(count: number): void {
  const futureReset = Date.now() + AUTH_RATE_LIMIT_WINDOW_MS;
  for (let i = 0; i < count; i++) {
    authRateLimitMap.set(`test-ip-${String(i)}`, { count: 1, resetAt: futureReset });
  }
}

/** Fill only refresh capacity with non-expired entries. Test-only. */
export function __fillRefreshRateLimitMapForTests(count: number): void {
  const futureReset = Date.now() + AUTH_RATE_LIMIT_WINDOW_MS;
  for (let index = 0; index < count; index++) {
    refreshRateLimitMap.set(`refresh:test-${String(index)}`, { count: 1, resetAt: futureReset });
  }
}

/** Fill only missing-secret capacity with non-expired entries. Test-only. */
export function __fillInvalidRefreshRateLimitMapForTests(count: number): void {
  const futureReset = Date.now() + AUTH_RATE_LIMIT_WINDOW_MS;
  for (let index = 0; index < count; index++) {
    invalidRefreshRateLimitMap.set(`refresh:invalid-test-${String(index)}`, { count: 1, resetAt: futureReset });
  }
}

/** Run the refresh token cleanup tick directly. Test-only. */
export async function __runRefreshTokenCleanupForTests(): Promise<void> {
  await runRefreshTokenCleanup();
}
