import { jwtDecrypt } from 'jose';
import { hkdf } from '@panva/hkdf';
import { db } from '../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { validateBetterAuthSession, validateBetterAuthBearer } from '../auth/index';

export interface AuthResult {
  userId: string;
  isAuthenticated: true;
}

export interface ControllerAuthResult {
  controllerId: string;
  controllerApiKey: string;
  userId: string | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
}

/**
 * Derive the encryption key the same way NextAuth does.
 * NextAuth uses HKDF with SHA-256 and a specific info string.
 */
async function deriveEncryptionKey(secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return await hkdf(
    'sha256',
    encoder.encode(secret),
    '',
    'NextAuth.js Generated Encryption Key',
    32
  );
}

/**
 * Validate a NextAuth JWT token (legacy).
 * NextAuth tokens are encrypted JWTs (JWE) using the NEXTAUTH_SECRET.
 *
 * @param token - The JWT token from the client
 * @returns Auth result with userId if valid, null if invalid
 */
export async function validateNextAuthToken(token: string): Promise<AuthResult | null> {
  try {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      console.warn('[Auth] NEXTAUTH_SECRET not configured');
      return null;
    }

    // Derive the encryption key the same way NextAuth does (using HKDF)
    const encryptionKey = await deriveEncryptionKey(secret);

    // Decrypt the NextAuth JWE token
    const { payload } = await jwtDecrypt(token, encryptionKey, {
      clockTolerance: 60, // Allow 60 seconds clock skew
    });

    // NextAuth stores user ID in the 'sub' claim
    const userId = payload.sub as string | undefined;
    if (!userId) {
      console.warn('[Auth] Token missing sub claim');
      return null;
    }

    return {
      userId,
      isAuthenticated: true,
    };
  } catch (error) {
    // Log the error but don't expose details to caller
    if (error instanceof Error) {
      console.warn('[Auth] NextAuth token validation failed:', error.message);
    }
    return null;
  }
}

/**
 * Validate an auth token using dual-strategy:
 * 1. Try Better Auth session token first
 * 2. Fall back to NextAuth JWE token
 *
 * Both paths return the same AuthResult interface.
 *
 * @param token - The auth token (could be Better Auth session token or NextAuth JWE)
 * @param cookies - Optional cookie string for Better Auth session validation
 * @returns Auth result with userId if valid, null if invalid
 */
export async function validateAuthToken(
  token: string,
  cookies?: string,
): Promise<AuthResult | null> {
  // Strategy 1: Try Better Auth session token
  // Better Auth session tokens are opaque strings, not JWTs
  // Check via cookie-based validation first
  if (cookies) {
    const sessionTokenMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
    if (sessionTokenMatch) {
      const result = await validateBetterAuthSession(sessionTokenMatch[1]);
      if (result) {
        return { userId: result.userId, isAuthenticated: true };
      }
    }
  }

  // Strategy 2: Try Better Auth bearer token validation
  const betterAuthResult = await validateBetterAuthBearer(token);
  if (betterAuthResult) {
    return { userId: betterAuthResult.userId, isAuthenticated: true };
  }

  // Strategy 3: Fall back to NextAuth JWE token
  return validateNextAuthToken(token);
}

/**
 * Extract auth token from various sources.
 * Checks connection params first, then falls back to URL query params.
 */
export function extractAuthToken(
  connectionParams?: Record<string, unknown>,
  requestUrl?: string
): string | null {
  // Check connection params (preferred method)
  if (connectionParams?.authToken && typeof connectionParams.authToken === 'string') {
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
 * Extract Better Auth session token from connection params cookies.
 * WebSocket clients may pass cookies via connection params.
 */
export function extractBetterAuthSessionToken(
  connectionParams?: Record<string, unknown>,
): string | null {
  // Check for explicit Better Auth session token in connection params
  if (connectionParams?.betterAuthSessionToken && typeof connectionParams.betterAuthSessionToken === 'string') {
    return connectionParams.betterAuthSessionToken;
  }

  // Check cookies in connection params
  if (connectionParams?.cookies && typeof connectionParams.cookies === 'string') {
    const match = connectionParams.cookies.match(/better-auth\.session_token=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Extract controller API key from connection params.
 * Controllers should pass their API key in connectionParams.controllerApiKey
 */
export function extractControllerApiKey(
  connectionParams?: Record<string, unknown>
): string | null {
  if (connectionParams?.controllerApiKey && typeof connectionParams.controllerApiKey === 'string') {
    return connectionParams.controllerApiKey;
  }
  return null;
}

/**
 * Validate a controller API key and return controller info.
 * Returns null if the API key is invalid or not found.
 */
export async function validateControllerApiKey(
  apiKey: string
): Promise<ControllerAuthResult | null> {
  try {
    const [controller] = await db
      .select()
      .from(esp32Controllers)
      .where(eq(esp32Controllers.apiKey, apiKey))
      .limit(1);

    if (!controller) {
      console.warn('[Auth] Controller API key not found');
      return null;
    }

    console.log(`[Auth] Authenticated controller: ${controller.id}`);
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
      console.warn('[Auth] Controller validation failed:', error.message);
    }
    return null;
  }
}
