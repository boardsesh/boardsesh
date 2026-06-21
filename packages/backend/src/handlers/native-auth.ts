import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { compare, hash } from 'bcryptjs';
import { eq, and, isNull, lt, or, isNotNull } from 'drizzle-orm';
import { mobileRefreshTokens, users, userCredentials, accounts, userProfiles } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { applyCorsHeaders } from './cors';
import { logger } from '../utils/logger';

/**
 * Fixed dummy bcrypt hash used to keep the credentials handler's response
 * time roughly constant for unknown emails / OAuth-only users. Without it,
 * an attacker could enumerate registered accounts by timing the response.
 * The plaintext is irrelevant — `compare` always returns false against it.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/oQbk1Ec7T0p/7K8nXfRzC2VyM4dy';

/** Generic error returned for all credential validation failures. */
const INVALID_CREDENTIALS_ERROR = 'Invalid email or password';

/**
 * Registration field bounds — mirror the web register route's Zod schema
 * (packages/web/app/api/auth/register/route.ts) so both signup paths accept
 * exactly the same inputs. The email regex is the same lax shape the web/mobile
 * client validators use: it rejects nothing the server would otherwise accept.
 */
const REGISTER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NAME_MAX_LENGTH = 100;
/** bcrypt cost factor — matches the web register route. */
const BCRYPT_COST = 12;

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
const CONSUMED_TOKEN_TTL_SECONDS = 125;
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
      // SET key "1" NX EX 125 — returns "OK" if set, null if key already existed
      const result = await publisher.set(redisKey, '1', 'EX', CONSUMED_TOKEN_TTL_SECONDS, 'NX');
      return result === 'OK' ? 'consumed' : 'replay';
    } catch (error) {
      // Redis failure: fall through to in-memory map so the endpoint stays available.
      logger.warn('[NativeAuth] Redis SET NX failed for consumed token, falling back to in-memory:', error);
    }
  }

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
    } catch (error) {
      logger.warn('[NativeAuth] Redis EXISTS failed for consumed token, falling back to in-memory:', error);
    }
  }
  return consumedTransferTokens.has(tokenSignature);
}

// ---------------------------------------------------------------------------
// IP-based rate limiting for auth endpoints
//
// Per-instance only — with N backend instances the effective limit is
// AUTH_RATE_LIMIT_MAX × N per IP. Redis-backed rate limiting would add
// a round-trip to every auth request for marginal benefit given that
// the high-risk replay path is already Redis-backed (SET NX EX).
// ---------------------------------------------------------------------------

type AuthRateLimitEntry = {
  count: number;
  resetAt: number;
};

/** Rate limit state per IP address. */
const authRateLimitMap = new Map<string, AuthRateLimitEntry>();

/** Maximum auth requests per IP per minute. */
const AUTH_RATE_LIMIT_MAX = 10;

/** Rate limit window in milliseconds (1 minute). */
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

/** Max entries before triggering early eviction. */
const MAX_RATE_LIMIT_ENTRIES = 50_000;

/** Evict expired entries from the rate limit map. */
function evictExpiredRateLimitEntries(): void {
  const now = Date.now();
  for (const [ipAddress, entry] of authRateLimitMap) {
    if (now > entry.resetAt) authRateLimitMap.delete(ipAddress);
  }
}

// Periodically clean up expired rate limit entries.
const rateLimitEvictionHandle = setInterval(evictExpiredRateLimitEntries, AUTH_RATE_LIMIT_WINDOW_MS);
if (typeof rateLimitEvictionHandle.unref === 'function') rateLimitEvictionHandle.unref();

/**
 * Check if an IP address has exceeded the auth endpoint rate limit.
 * Returns the number of seconds until the limit resets, or null if allowed.
 * Returns -1 if the rate limit map is full and cannot accept new entries
 * (callers should respond with 503).
 */
function checkAuthRateLimit(ipAddress: string): number | null {
  const now = Date.now();
  const entry = authRateLimitMap.get(ipAddress);

  if (!entry || now > entry.resetAt) {
    // New entry — check map bounds before inserting
    if (!entry && authRateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      evictExpiredRateLimitEntries();
      if (authRateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
        logger.warn(`[NativeAuth] Rate limit map full (${authRateLimitMap.size} entries)`);
        return -1;
      }
    }
    authRateLimitMap.set(ipAddress, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return null;
  }

  if (entry.count >= AUTH_RATE_LIMIT_MAX) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count++;
  return null;
}

/**
 * Extract the client IP from an incoming request.
 *
 * Uses `req.socket.remoteAddress` exclusively. X-Forwarded-For is user-controlled
 * and trusting its leftmost entry lets attackers bypass the rate limiter by
 * spoofing arbitrary IPs. Behind a reverse proxy (e.g. Railway), remoteAddress
 * is the proxy IP, which means all clients share one rate-limit bucket — overly
 * permissive but not bypassable.
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
};

function verifyTransferToken(token: string): { userId: string } | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    logger.warn('[NativeAuth] NEXTAUTH_SECRET not configured');
    return null;
  }

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
    !payload.userId ||
    !payload.exp ||
    !payload.iat ||
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

  return { userId: payload.userId };
}

// ---------------------------------------------------------------------------
// Token generation helpers
// ---------------------------------------------------------------------------

async function generateTokenPair(
  userId: string,
  txOrDb: { insert: typeof db.insert } = db,
): Promise<{
  jwt: string;
  refreshToken: string;
  expiresAt: string;
}> {
  const signingSecret = getSigningSecret();
  if (!signingSecret) {
    throw new Error('NEXTAUTH_SECRET is not configured');
  }

  // Generate JWT
  const jwtExpiresAt = new Date(Date.now() + JWT_EXPIRY_MS);
  const jwt = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_EXPIRY)
    .sign(signingSecret);

  // Generate refresh token and store its hash
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  await txOrDb.insert(mobileRefreshTokens).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
  });

  return {
    jwt,
    refreshToken,
    expiresAt: jwtExpiresAt.toISOString(),
  };
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
  const verified = verifyTransferToken(transferToken);
  if (!verified) {
    logger.warn('[NativeAuth] Transfer token verification failed');
    sendJson(res, 401, { error: 'Invalid or expired transfer token' });
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
    const tokenPair = await generateTokenPair(verified.userId);
    logger.info(`[NativeAuth] Token exchange successful for user ${verified.userId}`);
    sendJson(res, 200, tokenPair);
  } catch (error) {
    logger.error('[NativeAuth] Token generation failed:', error);
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

  // Normalize the email to match how NextAuth's adapter stores it.
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const userRows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    const user = userRows[0];

    if (!user) {
      // Dummy compare against a fixed hash to mask the user-lookup miss in
      // response time. Result is intentionally discarded.
      await compare(password, DUMMY_PASSWORD_HASH);
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }

    const credentialRows = await db.select().from(userCredentials).where(eq(userCredentials.userId, user.id)).limit(1);
    const credentials = credentialRows[0];

    if (!credentials) {
      // OAuth-only user with no password. Same dummy compare for timing parity.
      await compare(password, DUMMY_PASSWORD_HASH);
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }

    const passwordMatches = await compare(password, credentials.passwordHash);
    if (!passwordMatches) {
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }

    const tokenPair = await generateTokenPair(user.id);
    logger.info(`[NativeAuth] Credentials sign-in successful for user ${user.id}`);
    sendJson(res, 200, tokenPair);
  } catch (error) {
    logger.error('[NativeAuth] Credentials sign-in failed:', error);
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
// Email verification: the backend can't send a verification email, and
// handleNativeAuthCredentials never checks emailVerified, so the new user is
// auto-logged-in on the device regardless. We still honour
// EMAIL_VERIFICATION_ENABLED for the stored emailVerified value, mirroring the
// web register route: when the flag is on, accounts are created UNVERIFIED
// (emailVerified: null) so this native path can't mint verified accounts for
// arbitrary emails and thereby bypass web's verification gate
// (auth-options.ts blocks unverified credentials login when the flag is on).
// When the flag is off (the default), accounts are created verified.
// ---------------------------------------------------------------------------

export async function handleNativeAuthRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const { email, password, name } = body as Record<string, unknown>;

  // Email: present, a string, and matching the lax client-side shape. Validate
  // against the trimmed/lowercased form so a trailing space can't sneak past.
  if (typeof email !== 'string' || email.trim().length === 0) {
    sendJson(res, 400, { error: 'email and password are required' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!REGISTER_EMAIL_REGEX.test(normalizedEmail)) {
    sendJson(res, 400, { error: 'Invalid email address' });
    return;
  }

  // Password: present, a string, within bounds (mirrors the web Zod schema).
  if (typeof password !== 'string' || password.length === 0) {
    sendJson(res, 400, { error: 'email and password are required' });
    return;
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    sendJson(res, 400, { error: 'Password must be at least 8 characters' });
    return;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    sendJson(res, 400, { error: 'Password must be less than 128 characters' });
    return;
  }

  // Name: optional. An empty/whitespace-only string is treated as absent; the
  // display name then falls back to the email local-part (matches web).
  let trimmedName: string | undefined;
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string') {
      sendJson(res, 400, { error: 'name must be a string' });
      return;
    }
    const candidate = name.trim();
    if (candidate.length > NAME_MAX_LENGTH) {
      sendJson(res, 400, { error: 'Name must be less than 100 characters' });
      return;
    }
    if (candidate.length > 0) trimmedName = candidate;
  }

  try {
    // Pre-check keeps the clean 409 message without relying on a DB constraint
    // (users.email currently has no unique index — see the catch below).
    const existingRows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (existingRows[0]) {
      sendJson(res, 409, {
        error: 'An account with this email already exists. Please sign in with your existing account.',
      });
      return;
    }

    const passwordHash = await hash(password, BCRYPT_COST);
    // Mirror web: unverified when the verification gate is on, verified otherwise.
    const emailVerificationEnabled = process.env.EMAIL_VERIFICATION_ENABLED === 'true';

    const result = await db.transaction(async (tx) => {
      const newUserId = crypto.randomUUID();
      await tx.insert(users).values({
        id: newUserId,
        email: normalizedEmail,
        name: trimmedName ?? normalizedEmail.split('@')[0],
        emailVerified: emailVerificationEnabled ? null : new Date(),
      });
      await tx.insert(userCredentials).values({ userId: newUserId, passwordHash });
      // Mirror the web createUser event: every user gets a profile row.
      await tx.insert(userProfiles).values({ userId: newUserId }).onConflictDoNothing();
      const tokenPair = await generateTokenPair(newUserId, tx);
      return { userId: newUserId, tokenPair };
    });

    logger.info(`[NativeAuth] Registration successful for user ${result.userId}`);
    sendJson(res, 201, result.tokenPair);
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
    logger.error('[NativeAuth] Registration failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/oauth — native Sign in with Apple / Google
//
// The mobile app runs the native provider flow (expo-apple-authentication /
// @react-native-google-signin) and posts the provider's identity token here.
// We verify the token against the provider's JWKS, then find-or-create the
// Boardsesh user and issue our own mobile JWT pair. Account linking is by the
// provider's stable `sub`, falling back to email — mirroring the web
// NextAuth `allowDangerousEmailAccountLinking: true` behaviour.
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

type OAuthProvider = 'apple' | 'google';

type ForwardedName = { firstName?: string; lastName?: string };

/**
 * The identity claims we trust from a verified provider token. `sub` is the
 * provider's stable per-user id (used for account linking); `email` may be
 * absent on Apple resubmissions (handled by the sub lookup).
 */
type VerifiedOAuthIdentity = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

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
 * claims we need. Returns null on any verification failure (bad signature,
 * wrong issuer/audience, expired, nonce mismatch). Network-free in tests when
 * `jose.jwtVerify` is mocked.
 */
async function verifyProviderIdentityToken(
  provider: OAuthProvider,
  identityToken: string,
  nonce?: string,
): Promise<VerifiedOAuthIdentity | null> {
  try {
    if (provider === 'apple') {
      const { payload } = await jwtVerify(identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: APPLE_BUNDLE_ID,
        // Both providers sign id tokens with RS256; pin it so a future JWKS that
        // also advertises a weaker/asymmetric-confusable alg can't be selected.
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      if (!payload.sub || !verifyNonce(nonce, payload.nonce)) return null;
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        // Apple never returns the name in the token — it's delivered once, in
        // the authorization response, and forwarded by the client separately.
        name: null,
      };
    }

    const audiences = getGoogleAudiences();
    if (audiences.length === 0) {
      logger.error('[NativeAuth] No Google client IDs configured — cannot verify Google token');
      return null;
    }
    const { payload } = await jwtVerify(identityToken, googleJwks, {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });
    if (!payload.sub || !verifyNonce(nonce, payload.nonce)) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  } catch (error) {
    logger.warn('[NativeAuth] OAuth identity token verification failed:', error);
    return null;
  }
}

/** Build a display name from the forwarded Apple name or the Google token. */
function resolveDisplayName(identity: VerifiedOAuthIdentity, forwardedName: ForwardedName | undefined): string | null {
  if (forwardedName) {
    const parts = [forwardedName.firstName, forwardedName.lastName].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(' ').trim();
  }
  return identity.name;
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
  | { status: 'ok'; tokenPair: { jwt: string; refreshToken: string; expiresAt: string }; userId: string }
  | { status: 'no_email' };

/**
 * Resolve the Boardsesh user for a verified identity and mint a token pair,
 * all inside one transaction:
 *   1. Existing `accounts` row for (provider, sub) → that user.
 *   2. Else a `users` row matching the normalized email → link it (insert the
 *      accounts row; mark email verified when the provider asserts it).
 *   3. Else create the user + profile + accounts link.
 * Apple resubmissions omit the email but always resolve via step 1.
 */
async function findOrCreateOAuthUser(
  provider: OAuthProvider,
  identity: VerifiedOAuthIdentity,
  forwardedName: ForwardedName | undefined,
): Promise<FindOrCreateResult> {
  return db.transaction(async (tx) => {
    // 1. Link by the provider's stable subject id.
    const linkedRows = await tx
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub)))
      .limit(1);
    const linked = linkedRows[0];
    if (linked) {
      const tokenPair = await generateTokenPair(linked.userId, tx);
      return { status: 'ok', tokenPair, userId: linked.userId };
    }

    const normalizedEmail = identity.email ? identity.email.trim().toLowerCase() : null;

    // 2. Link by email — ONLY when the provider asserts the email is verified.
    // This is the security boundary NextAuth's allowDangerousEmailAccountLinking
    // leaves to the provider: auto-linking an *unverified* provider email to an
    // existing account would let anyone able to mint a token for an arbitrary
    // email claim take over that account. Apple always verifies (real or relay);
    // Google's email_verified is almost always true. An unverified email falls
    // through to creation, which anchors on the provider sub instead.
    if (normalizedEmail && identity.emailVerified) {
      const matchedRows = await tx
        .select({ id: users.id, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);
      const matched = matchedRows[0];
      if (matched) {
        await tx
          .insert(accounts)
          .values({ userId: matched.id, type: 'oauth', provider, providerAccountId: identity.sub })
          .onConflictDoNothing();
        if (!matched.emailVerified) {
          await tx.update(users).set({ emailVerified: new Date() }).where(eq(users.id, matched.id));
        }
        const tokenPair = await generateTokenPair(matched.id, tx);
        return { status: 'ok', tokenPair, userId: matched.id };
      }
    }

    // 3. Create. Email is NOT NULL on `users`; Apple/Google both return an
    // email on first authorization (Apple's relay address when hidden), so a
    // brand-new sub without an email is unexpected — reject rather than
    // fabricate one.
    if (!normalizedEmail) {
      return { status: 'no_email' };
    }

    const newUserId = crypto.randomUUID();
    await tx.insert(users).values({
      id: newUserId,
      email: normalizedEmail,
      name: resolveDisplayName(identity, forwardedName),
      emailVerified: identity.emailVerified ? new Date() : null,
    });
    // Mirror the web `createUser` event: every user gets a profile row.
    await tx.insert(userProfiles).values({ userId: newUserId }).onConflictDoNothing();
    await tx.insert(accounts).values({ userId: newUserId, type: 'oauth', provider, providerAccountId: identity.sub });
    const tokenPair = await generateTokenPair(newUserId, tx);
    return { status: 'ok', tokenPair, userId: newUserId };
  });
}

export async function handleNativeAuthOAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const identity = await verifyProviderIdentityToken(provider, identityToken, nonce);
  if (!identity) {
    sendJson(res, 401, { error: 'Invalid or expired identity token' });
    return;
  }

  try {
    const result = await findOrCreateOAuthUser(provider, identity, parseForwardedName(name));
    if (result.status === 'no_email') {
      logger.warn(`[NativeAuth] ${provider} sign-in for a new account without an email — rejecting`);
      sendJson(res, 401, { error: 'An email is required to create an account' });
      return;
    }
    logger.info(`[NativeAuth] ${provider} sign-in successful for user ${result.userId}`);
    sendJson(res, 200, result.tokenPair);
  } catch (error) {
    logger.error('[NativeAuth] OAuth sign-in failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
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

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    sendJson(res, 400, { error: 'refreshToken is required' });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  try {
    const result = await db.transaction(async (tx) => {
      // Atomically revoke the token and return it in a single query.
      // This prevents TOCTOU races: if two concurrent requests present the same
      // refresh token, only one will get the row back — the other gets an empty
      // result because the WHERE clause requires revoked_at IS NULL.
      const revokedRows = await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(mobileRefreshTokens.tokenHash, tokenHash), isNull(mobileRefreshTokens.revokedAt)))
        .returning();

      const revokedToken = revokedRows[0];
      if (!revokedToken) {
        return { status: 401 as const, error: 'Invalid refresh token' };
      }

      if (revokedToken.expiresAt < new Date()) {
        return { status: 401 as const, error: 'Refresh token expired' };
      }

      const tokenPair = await generateTokenPair(revokedToken.userId, tx);
      return { status: 200 as const, tokenPair, userId: revokedToken.userId };
    });

    if (result.status !== 200) {
      sendJson(res, result.status, { error: result.error });
      return;
    }

    logger.info(`[NativeAuth] Token refresh successful for user ${result.userId}`);
    sendJson(res, 200, result.tokenPair);
  } catch (error) {
    logger.error('[NativeAuth] Token refresh failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
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
    // Look up the token to find the user. Only non-revoked tokens are valid
    // for initiating a full sign-out.
    const matchingRows = await db
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.tokenHash, tokenHash), isNull(mobileRefreshTokens.revokedAt)))
      .returning({ userId: mobileRefreshTokens.userId });

    const matchedToken = matchingRows[0];

    if (!matchedToken) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }

    // Revoke ALL remaining non-revoked tokens for this user (full sign-out).
    // The token we just revoked above is already covered, but the WHERE clause
    // filters on revokedAt IS NULL so it's a no-op for that row.
    await db
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.userId, matchedToken.userId), isNull(mobileRefreshTokens.revokedAt)));

    logger.info(`[NativeAuth] All tokens revoked for user ${matchedToken.userId}`);
    sendJson(res, 200, { revoked: true });
  } catch (error) {
    logger.error('[NativeAuth] Token revocation failed:', error);
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
  const revokedCutoff = new Date(Date.now() - REVOKED_TOKEN_RETENTION_MS);
  const now = new Date();
  try {
    const result = await db
      .delete(mobileRefreshTokens)
      .where(
        or(
          // Revoked tokens older than 7 days
          and(isNotNull(mobileRefreshTokens.revokedAt), lt(mobileRefreshTokens.revokedAt, revokedCutoff)),
          // Expired tokens
          lt(mobileRefreshTokens.expiresAt, now),
        ),
      )
      .returning({ id: mobileRefreshTokens.id });
    if (result.length > 0) {
      logger.info(`[NativeAuth Cleanup] Removed ${String(result.length)} expired/revoked refresh token(s)`);
    }
  } catch (error) {
    logger.error('[NativeAuth Cleanup] Failed to remove expired refresh tokens:', error);
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
    runRefreshTokenCleanup().catch((error) => {
      logger.error('[NativeAuth Cleanup] Initial tick failed:', error);
    });
  }, 60 * 1000);
  if (typeof initialDelay.unref === 'function') initialDelay.unref();

  refreshTokenCleanupHandle = setInterval(() => {
    runRefreshTokenCleanup().catch((error) => {
      logger.error('[NativeAuth Cleanup] Tick failed:', error);
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

/** Run the refresh token cleanup tick directly. Test-only. */
export async function __runRefreshTokenCleanupForTests(): Promise<void> {
  await runRefreshTokenCleanup();
}
