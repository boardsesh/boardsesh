import { createHash, createHmac, createSecretKey, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * `auth_session.token` stores this digest of a session token, never the token.
 * A copy of the table (a dump, the DR standby, a backup) then holds nothing a
 * browser could present. Lookups hash the presented token and compare digests.
 * Better Auth's own session API (`createAuthority`, unmounted; no Better Auth
 * handler faces browsers) would still write clear tokens, which this reader
 * refuses.
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** A new opaque session token: the raw value for the one reply that hands it out, and the digest the row stores. */
export function newSessionToken(): { readonly token: string; readonly stored: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, stored: sessionTokenDigest(token) };
}

const BRIDGE_TOKEN_KEY_LABEL = 'boardsesh-bridge-token-key-v1';
const BRIDGE_TOKEN_LABEL = 'boardsesh-bridge-token-v1:';

/**
 * The key that turns a bridged session's id into its token (#7596, owner
 * decision 3). It holds a `KeyObject`, so logging it prints no key bytes.
 * Session ids plus this key mint every bridged token, so it lives only in the
 * backend's environment, never in the database or on www.
 */
export interface BridgeTokenKey {
  readonly kind: 'bridge-token-key';
  readonly key: KeyObject;
}

/**
 * Derives the bridge key from `AUTH_BRIDGE_TOKEN_SECRET` with HKDF-SHA256 and
 * a fixed label, so the secret itself is never the HMAC key and a later
 * version can derive another key from the same secret. At least 32 bytes, no
 * surrounding spaces.
 */
export function bridgeTokenKey(secret: string): BridgeTokenKey {
  if (!secret || secret !== secret.trim() || Buffer.byteLength(secret, 'utf8') < 32)
    throw new Error('Invalid bridge token secret');
  const material = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), BRIDGE_TOKEN_KEY_LABEL, 32));
  return Object.freeze({ kind: 'bridge-token-key', key: createSecretKey(material) });
}

/**
 * The token of a bridged session: base64url(HMAC-SHA256(key,
 * "boardsesh-bridge-token-v1:" + sessionId)), 43 characters like a minted one.
 * The same legacy login always bridges to the same token, so a browser that
 * lost the bridge reply gets it again. The row still stores only the digest.
 */
export function bridgedSessionToken(
  tokenKey: BridgeTokenKey,
  sessionId: string,
): { readonly token: string; readonly stored: string } {
  const token = createHmac('sha256', tokenKey.key)
    .update(`${BRIDGE_TOKEN_LABEL}${sessionId}`, 'utf8')
    .digest('base64url');
  return { token, stored: sessionTokenDigest(token) };
}
