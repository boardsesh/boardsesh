import { jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { db } from '../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { decryptLegacyWebJwe } from '../auth/legacy-web-jwe';
import {
  AuthAdmissionUnavailableError,
  AuthCredentialRefusedError,
  admitsCredential,
  readHumanSubjectState,
} from '../auth/human-admission';
import { decideCredential, type PresentedCredential } from '../auth/credential-cutoffs';

export type AuthResult = {
  userId: string;
  isAuthenticated: true;
  credentialExpiresAt?: number;
  /** The stamps admission decided on, so the WebSocket sweep can decide again without decrypting. */
  credential: PresentedCredential;
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

// Short-lived in-process cache for verified tokens: token → { result, expiresAt }
// Avoids repeated JWE decryption for the same token across rapid requests. It
// holds cryptography only: admission (account, generations) is read every call.
const TOKEN_CACHE_TTL_MS = 60_000; // 60 seconds
type TokenCacheEntry = {
  result: AuthResult;
  expiresAt: number;
  format: 'jwe' | 'jws';
  secretDigest: string;
};
const tokenCache = new Map<string, TokenCacheEntry>();

// Periodically evict stale entries so the map doesn't grow unbounded.
const cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}, TOKEN_CACHE_TTL_MS);
cacheCleanup.unref();

function requireSigningSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthAdmissionUnavailableError();
  return secret;
}

function secretDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function cacheCryptoResult(token: string, result: AuthResult, format: TokenCacheEntry['format'], secret: string) {
  tokenCache.set(token, {
    result: Object.freeze({ ...result, credential: Object.freeze(result.credential) }),
    format,
    secretDigest: secretDigest(secret),
    expiresAt: Math.min(Date.now() + TOKEN_CACHE_TTL_MS, (result.credentialExpiresAt ?? Infinity) + 60_000),
  });
}

export type ValidateTokenOptions = {
  /**
   * Throw `AuthCredentialRefusedError` for a credential we signed that
   * `decideCredential` refuses, instead of returning null. The optional-credential
   * transports (GraphQL HTTP, the WebSocket handshake) need it to tell a refused
   * credential, which must sign the app out, from an expired or foreign one,
   * which stays anonymous.
   */
  readonly throwOnRefusal?: boolean;
};

async function admitCryptoResult(
  result: AuthResult | null,
  { throwOnRefusal = false }: ValidateTokenOptions,
): Promise<AuthResult | null> {
  // Keep database uncertainty OUTSIDE cryptographic catches. Every invocation,
  // including a warm cache and either direct exported validator, checks primary.
  if (!result) return null;
  const subject = await readHumanSubjectState(result.userId);
  if (admitsCredential(decideCredential(result.credential, subject, Date.now()), 'request')) return result;
  if (throwOnRefusal) throw new AuthCredentialRefusedError();
  return null;
}

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
async function verifyNextAuthToken(token: string, secret: string): Promise<AuthResult | null> {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached?.format === 'jwe' && cached.expiresAt > now && cached.secretDigest === secretDigest(secret)) {
    return cached.result;
  }

  try {
    const { payload } = await decryptLegacyWebJwe(token, secret, 60);

    const userId = payload.sub;
    if (!userId) {
      logger.warn('[Auth] Token missing sub claim');
      return null;
    }

    const result: AuthResult = {
      userId,
      isAuthenticated: true,
      ...(typeof payload.exp === 'number' ? { credentialExpiresAt: payload.exp * 1000 } : {}),
      credential: {
        kind: 'web-session',
        generationClaim: payload.gen,
        sessionKeyClaim: payload.authSessionId,
        authTimeClaim: payload.auth_time,
      },
    };
    cacheCryptoResult(token, result, 'jwe', secret);
    return result;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('[Auth] Token validation failed:', error.message);
    }
    return null;
  }
}

export async function validateNextAuthToken(
  token: string,
  options: ValidateTokenOptions = {},
): Promise<AuthResult | null> {
  return admitCryptoResult(await verifyNextAuthToken(token, requireSigningSecret()), options);
}

/**
 * Validate a mobile JWT (JWS) token.
 * Mobile tokens are standard signed JWTs (3 dot-separated segments) created
 * by the native auth exchange/refresh endpoints, signed with NEXTAUTH_SECRET.
 *
 * @param token - The JWS token from the mobile client
 * @returns Auth result with userId if valid, null if invalid
 */
async function verifyMobileJwt(token: string, secret: string): Promise<AuthResult | null> {
  const cached = tokenCache.get(token);
  if (cached?.format === 'jws' && cached.expiresAt > Date.now() && cached.secretDigest === secretDigest(secret))
    return cached.result;
  try {
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

    const result: AuthResult = {
      userId,
      isAuthenticated: true,
      ...(typeof payload.exp === 'number' ? { credentialExpiresAt: payload.exp * 1000 } : {}),
      credential: {
        kind: 'native-access',
        generationClaim: payload.gen,
        nativeGenerationClaim: payload.ngen,
        authTimeClaim: payload.auth_time,
      },
    };
    cacheCryptoResult(token, result, 'jws', secret);
    return result;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('[Auth] Mobile JWT validation failed:', error.message);
    }
    return null;
  }
}

export async function validateMobileJwt(token: string, options: ValidateTokenOptions = {}): Promise<AuthResult | null> {
  return admitCryptoResult(await verifyMobileJwt(token, requireSigningSecret()), options);
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
export async function validateToken(token: string, options: ValidateTokenOptions = {}): Promise<AuthResult | null> {
  // JWE tokens (NextAuth) have 5 dot-separated segments,
  // JWS tokens (mobile JWT) have 3 segments.
  const segments = token.split('.').length;
  if (segments === 5) {
    return validateNextAuthToken(token, options);
  } else if (segments === 3) {
    return validateMobileJwt(token, options);
  }
  return null;
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
