import { jwtDecrypt, jwtVerify } from 'jose';
import { hkdf } from '@panva/hkdf';
import { db } from '../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';

export type AuthResult = {
  userId: string;
  isAuthenticated: true;
};

export type ControllerAuthResult = {
  controllerId: string;
  controllerApiKey: string;
  userId: string | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

// Cache the derived encryption key — it only changes if NEXTAUTH_SECRET changes,
// which requires a process restart anyway.
let cachedEncryptionKey: Uint8Array | null = null;
let cachedSecret: string | null = null;

async function deriveEncryptionKey(secret: string): Promise<Uint8Array> {
  if (cachedEncryptionKey && cachedSecret === secret) {
    return cachedEncryptionKey;
  }
  const encoder = new TextEncoder();
  cachedEncryptionKey = await hkdf('sha256', encoder.encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  cachedSecret = secret;
  return cachedEncryptionKey;
}

// Short-lived in-process cache for validated tokens: token → { result, expiresAt }
// Avoids repeated JWE decryption for the same token across rapid requests.
const TOKEN_CACHE_TTL_MS = 60_000; // 60 seconds
type TokenCacheEntry = {
  result: AuthResult;
  expiresAt: number;
};
const tokenCache = new Map<string, TokenCacheEntry>();

// Periodically evict stale entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}, TOKEN_CACHE_TTL_MS);

/**
 * Validate a NextAuth JWT token.
 * NextAuth tokens are encrypted JWTs (JWE) using the NEXTAUTH_SECRET.
 *
 * Successful results are cached in-process for 60 seconds to avoid repeated
 * HKDF + JWE decryption on every request when many connections share the same
 * token. Failed validations are not cached so transient errors don't persist.
 *
 * @param token - The JWT token from the client
 * @returns Auth result with userId if valid, null if invalid
 */
export async function validateNextAuthToken(token: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  try {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      logger.warn('[Auth] NEXTAUTH_SECRET not configured');
      return null;
    }

    const encryptionKey = await deriveEncryptionKey(secret);

    const { payload } = await jwtDecrypt(token, encryptionKey, {
      clockTolerance: 60,
    });

    const userId = payload.sub;
    if (!userId) {
      logger.warn('[Auth] Token missing sub claim');
      return null;
    }

    const result: AuthResult = { userId, isAuthenticated: true };
    tokenCache.set(token, { result, expiresAt: now + TOKEN_CACHE_TTL_MS });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('[Auth] Token validation failed:', error.message);
    }
    return null;
  }
}

/**
 * Validate a mobile JWT (JWS) token.
 * Mobile tokens are standard signed JWTs (3 dot-separated segments) created
 * by the native auth exchange/refresh endpoints, signed with NEXTAUTH_SECRET.
 *
 * @param token - The JWS token from the mobile client
 * @returns Auth result with userId if valid, null if invalid
 */
export async function validateMobileJwt(token: string): Promise<AuthResult | null> {
  try {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      logger.warn('[Auth] NEXTAUTH_SECRET not configured');
      return null;
    }

    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretKey, {
      clockTolerance: 60,
      issuer: 'boardsesh',
      audience: 'boardsesh-mobile',
    });

    const userId = payload.sub;
    if (!userId) {
      logger.warn('[Auth] Mobile JWT missing sub claim');
      return null;
    }

    return { userId, isAuthenticated: true };
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('[Auth] Mobile JWT validation failed:', error.message);
    }
    return null;
  }
}

/**
 * Validate any auth token — NextAuth JWE (5 segments) or mobile JWS (3 segments).
 *
 * Successful results are cached in-process for 60 seconds to avoid repeated
 * cryptographic operations on every request when many connections share the
 * same token. Failed validations are not cached so transient errors don't
 * persist.
 *
 * @param token - The token from the client (JWE or JWS)
 * @returns Auth result with userId if valid, null if invalid
 */
export async function validateToken(token: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  let result: AuthResult | null = null;

  // JWE tokens (NextAuth) have 5 dot-separated segments,
  // JWS tokens (mobile JWT) have 3 segments.
  const segments = token.split('.').length;
  if (segments === 5) {
    result = await validateNextAuthToken(token);
  } else if (segments === 3) {
    result = await validateMobileJwt(token);
  }

  // Cache successful results only (validateNextAuthToken already caches
  // internally, but for mobile JWTs this is the only caching layer).
  // Null results are not cached so transient failures (e.g. secret unset
  // during restart) don't persist as permanent rejections.
  if (segments === 3 && result) {
    tokenCache.set(token, { result, expiresAt: now + TOKEN_CACHE_TTL_MS });
  }

  return result;
}

/**
 * Extract auth token from various sources.
 * Checks connection params first, then falls back to URL query params.
 */
export function extractAuthToken(connectionParams?: Record<string, unknown>, requestUrl?: string): string | null {
  // Check connection params (preferred method). A present-but-empty or non-string
  // authToken (e.g. an anonymous web client that sends `authToken: null`) is
  // treated as "no credential": fall through to the URL token and, ultimately,
  // anonymous. Returning "" here instead would hand validateToken an empty string
  // — a spurious "Invalid WebSocket auth token" warning on every anonymous
  // connection — and skip the ?token= fallback below.
  if (connectionParams && typeof connectionParams.authToken === 'string' && connectionParams.authToken.length > 0) {
    return connectionParams.authToken;
  }

  // Fall back to URL query params
  if (requestUrl) {
    try {
      const url = new URL(requestUrl, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        return token;
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  return null;
}

/**
 * Extract controller API key from connection params.
 * Controllers should pass their API key in connectionParams.controllerApiKey
 */
export function extractControllerApiKey(connectionParams?: Record<string, unknown>): string | null {
  if (connectionParams?.controllerApiKey && typeof connectionParams.controllerApiKey === 'string') {
    return connectionParams.controllerApiKey;
  }
  return null;
}

/**
 * Validate a controller API key and return controller info.
 * Returns null if the API key is invalid or not found.
 */
export async function validateControllerApiKey(apiKey: string): Promise<ControllerAuthResult | null> {
  try {
    const [controller] = await db.select().from(esp32Controllers).where(eq(esp32Controllers.apiKey, apiKey)).limit(1);

    if (!controller) {
      logger.warn('[Auth] Controller API key not found');
      return null;
    }

    logger.info(`[Auth] Authenticated controller: ${controller.id}`);
    return {
      controllerId: controller.id,
      controllerApiKey: apiKey,
      userId: controller.userId,
      boardName: controller.boardName,
      layoutId: controller.layoutId,
      sizeId: controller.sizeId,
      setIds: controller.setIds,
    };
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('[Auth] Controller validation failed:', error.message);
    }
    return null;
  }
}
