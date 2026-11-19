/**
 * Device tokens (#7656): a signed note that this browser or phone has signed in
 * to one account before. A later change exempts such a device from the
 * per-account password guess limit, so the owner is never locked out by
 * someone guessing from elsewhere.
 *
 * Server only: the web and the backend mint and verify with one shared secret.
 * The phone stores the string it is given and sends it back; it never imports
 * this module. Web Crypto only, so the web can import it without Node types.
 *
 * Format: `v1.<token id>.<issued at, epoch seconds>.<mac>`. The MAC is
 * HMAC-SHA256 over the version, token id, user id and issued-at. The user id
 * is not in the string: verification recomputes the MAC for the account being
 * signed in to, so a token minted for one account says nothing about another
 * and the cookie does not carry the user id.
 */

export const DEVICE_TOKEN_SECRET_ENV = 'AUTH_DEVICE_TOKEN_SECRET';
export const DEVICE_TOKEN_VERSION = 1;
/** 400 days, the longest cookie lifetime browsers honour. */
export const DEVICE_TOKEN_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
/** Longer than any token this module mints; anything longer is not read. */
export const DEVICE_TOKEN_MAX_LENGTH = 128;

/** Five minutes of clock difference between the two services. */
const ISSUED_AT_SKEW_SECONDS = 300;
const MINIMUM_SECRET_BYTES = 32;
/** Issued-at has no leading zero, so each token has exactly one spelling. */
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{22})\.([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAC_DOMAIN = 'boardsesh-device-token';
/** Every other auth secret; the device secret must differ from each. */
export const DEVICE_TOKEN_OTHER_SECRET_ENV = [
  'NEXTAUTH_SECRET',
  'CRON_SECRET',
  'CURRENT_STORE_AUTH_RPC_SECRET',
  'CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET',
  'CURRENT_STORE_DELETED_EMAIL_KEY',
  'AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY',
  'AUTH_BROWSER_SESSION_COOKIE_SECRET',
  'AUTH_BROWSER_ACCESS_TOKEN_SECRET',
  'AUTH_BRIDGE_TOKEN_SECRET',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export type DeviceTokenSecret = { readonly secret: string } | { readonly problem: 'unset' | 'invalid' };

const encoder = new TextEncoder();

/**
 * The shared secret, or why there is none. Unset means device tokens are off:
 * nothing is minted and every token reads as absent. Shorter than 32 bytes,
 * padded with spaces, or equal to another auth secret is `invalid`, which
 * callers treat as off and log once by name. Never throws, so a bad value
 * cannot stop either service from starting.
 */
export function readDeviceTokenSecret(environment: Environment): DeviceTokenSecret {
  const secret = environment[DEVICE_TOKEN_SECRET_ENV];
  if (!secret) return { problem: 'unset' };
  if (
    secret !== secret.trim() ||
    encoder.encode(secret).length < MINIMUM_SECRET_BYTES ||
    DEVICE_TOKEN_OTHER_SECRET_ENV.some((name) => environment[name] === secret)
  )
    return { problem: 'invalid' };
  return { secret };
}

export interface DeviceTokenClaims {
  /**
   * 16 random bytes, base64url. Refresh and exchange mint a new one on every
   * reply, so the guess counter keys recognised devices on the account, never on this.
   */
  readonly tokenId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface MintedDeviceToken extends DeviceTokenClaims {
  readonly token: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function macKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** A JSON array keeps the fields unambiguous whatever characters a user id holds. */
function macMessage(tokenId: string, userId: string, issuedAtSeconds: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([MAC_DOMAIN, DEVICE_TOKEN_VERSION, tokenId, userId, issuedAtSeconds]));
}

function claims(tokenId: string, issuedAtSeconds: number): DeviceTokenClaims {
  return Object.freeze({
    tokenId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    expiresAt: new Date((issuedAtSeconds + DEVICE_TOKEN_LIFETIME_SECONDS) * 1000),
  });
}

/** A new token for `userId`, with a fresh random id unless one is given. */
export async function mintDeviceToken(input: {
  readonly userId: string;
  readonly secret: string;
  readonly now?: Date;
  readonly tokenId?: string;
}): Promise<MintedDeviceToken> {
  if (!input.userId) throw new Error('A device token needs a user id');
  if (encoder.encode(input.secret).length < MINIMUM_SECRET_BYTES) throw new Error('Device token secret too short');
  const tokenId = input.tokenId ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  if (!TOKEN_ID_PATTERN.test(tokenId)) throw new Error('Invalid device token id');
  const issuedAtSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const key = await macKey(input.secret, 'sign');
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, macMessage(tokenId, input.userId, issuedAtSeconds)),
  );
  return Object.freeze({
    token: `v${DEVICE_TOKEN_VERSION}.${tokenId}.${issuedAtSeconds}.${toBase64Url(signature)}`,
    ...claims(tokenId, issuedAtSeconds),
  });
}

/**
 * The token's claims when it was minted for `userId` under `secret` and has
 * not expired; otherwise null. Malformed, forged, expired, issued in the
 * future, or minted for another account all read as absent, never as an error.
 * The MAC is checked by Web Crypto's HMAC verify, which compares in constant time.
 */
export async function verifyDeviceToken(
  token: unknown,
  expected: { readonly userId: string; readonly secret: string; readonly now?: Date },
): Promise<DeviceTokenClaims | null> {
  if (typeof token !== 'string' || token.length > DEVICE_TOKEN_MAX_LENGTH || !expected.userId) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, tokenId, issuedAtText, signatureText] = match;
  const issuedAtSeconds = Number(issuedAtText);
  const nowSeconds = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(issuedAtSeconds)) return null;
  if (issuedAtSeconds > nowSeconds + ISSUED_AT_SKEW_SECONDS) return null;
  if (nowSeconds >= issuedAtSeconds + DEVICE_TOKEN_LIFETIME_SECONDS) return null;
  const signature = fromBase64Url(signatureText);
  // Only the canonical encoding of a MAC is a token; this compares public text, not the secret.
  if (signature.length !== 32 || toBase64Url(signature) !== signatureText) return null;
  try {
    const key = await macKey(expected.secret, 'verify');
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      macMessage(tokenId, expected.userId, issuedAtSeconds),
    );
    return valid ? claims(tokenId, issuedAtSeconds) : null;
  } catch {
    return null;
  }
}
