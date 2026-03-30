/**
 * Kilter API client using OAuth2/Keycloak authentication.
 *
 * Auth flow:
 *   1. POST credentials to Keycloak IDP → receive JWT access_token
 *   2. Decode JWT to extract user UUID from `sub` claim
 *   3. Use Bearer token for all subsequent API calls
 *
 * Endpoints:
 *   - IDP:  https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token
 *   - API:  https://portal.kiltergrips.com/api
 *   - Sync: https://sync1.kiltergrips.com/sync/stream
 */

import type { KilterTokenResponse, KilterLoginResult, KilterSyncData } from './types';

const KILTER_IDP_URL = 'https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token';
const KILTER_API_BASE = 'https://portal.kiltergrips.com/api';
const KILTER_SYNC_URL = 'https://sync1.kiltergrips.com/sync/stream';

/**
 * Decode a JWT and return the payload. Does NOT verify the signature —
 * the token was received directly from the IDP over HTTPS so
 * signature verification is unnecessary for extracting claims.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  // Base64url → Base64
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

/**
 * Extract the user UUID from a Kilter JWT access token.
 */
export function getUserUuidFromToken(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('JWT does not contain a valid `sub` claim');
  }
  return sub;
}

export class KilterClient {
  private accessToken: string | null = null;
  private userUuid: string | null = null;

  /** Set an existing token (e.g. from encrypted storage) */
  setToken(accessToken: string): void {
    this.accessToken = accessToken;
    this.userUuid = getUserUuidFromToken(accessToken);
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getUserUuid(): string | null {
    return this.userUuid;
  }

  /**
   * Authenticate with Kilter via Keycloak Resource Owner Password Credentials grant.
   */
  async signIn(username: string, password: string): Promise<KilterLoginResult> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: 'kilter-app', // public client, no secret
      username,
      password,
    });

    const response = await fetch(KILTER_IDP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 400) {
        // Keycloak returns 401 for bad credentials
        let detail = '';
        try {
          const errJson = (await response.json()) as Record<string, unknown>;
          detail = (errJson.error_description as string) || (errJson.error as string) || '';
        } catch {
          // ignore parse errors
        }
        throw new Error(detail || 'Invalid username or password');
      }
      if (response.status === 429) {
        throw new Error('Too many login attempts. Please try again later.');
      }
      throw new Error(`Kilter IDP error: ${response.status} ${response.statusText}`);
    }

    const tokenResponse = (await response.json()) as KilterTokenResponse;

    if (!tokenResponse.access_token) {
      throw new Error('Login succeeded but no access_token returned');
    }

    this.accessToken = tokenResponse.access_token;
    this.userUuid = getUserUuidFromToken(tokenResponse.access_token);

    return {
      accessToken: tokenResponse.access_token,
      userUuid: this.userUuid,
      username,
    };
  }

  /**
   * Make an authenticated GET request to the Kilter API.
   */
  async apiGet<T>(endpoint: string): Promise<T> {
    if (!this.accessToken) {
      throw new Error('Not authenticated — call signIn() first');
    }

    const url = `${KILTER_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kilter API GET ${endpoint} failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make an authenticated POST request to the Kilter API.
   */
  async apiPost<T>(endpoint: string, body: unknown): Promise<T> {
    if (!this.accessToken) {
      throw new Error('Not authenticated — call signIn() first');
    }

    const url = `${KILTER_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kilter API POST ${endpoint} failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Call the Kilter sync stream endpoint.
   * Accepts URL-encoded form data (same format as old Aurora /sync)
   * but uses Bearer auth instead of Cookie auth.
   */
  async syncStream(formBody: string): Promise<KilterSyncData> {
    if (!this.accessToken) {
      throw new Error('Not authenticated — call signIn() first');
    }

    const response = await fetch(KILTER_SYNC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
      signal: AbortSignal.timeout(60000), // Sync can be slow
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kilter sync stream failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<KilterSyncData>;
  }
}

export default KilterClient;
