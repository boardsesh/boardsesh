import { jwtDecrypt } from 'jose';
import { hkdf } from '@panva/hkdf';
import { createRequestDb } from '@boardsesh/db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';

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
 * Validate a NextAuth JWT token.
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
      console.warn('[Auth] Token validation failed:', error.message);
    }
    return null;
  }
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
  const db = createRequestDb();
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

