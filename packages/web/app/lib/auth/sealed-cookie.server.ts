import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The sealing behind www's short-lived flow cookies (#7596 B5e1, B5e2):
 * AES-256-GCM under a key derived with HKDF-SHA256 from www's
 * `AUTH_BROWSER_SESSION_COOKIE_SECRET` and a label of the cookie's own, with
 * the cookie name as associated data, so one cookie's value never opens as
 * another's. Values are base64url: IV, ciphertext, tag.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed record is a few hundred bytes; anything far larger is not ours, and a seal refuses to write it. */
export const MAX_SEALED_LENGTH = 3072;

function sealingKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), label, 32));
}

/** The record would not fit in a cookie the reader accepts. */
export class SealedCookieTooLarge extends Error {
  constructor() {
    super('Sealed cookie too large');
    this.name = 'SealedCookieTooLarge';
  }
}

export function sealCookieValue(secret: string, label: string, name: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(secret, label), iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const value = Buffer.concat([iv, sealed]).toString('base64url');
  // What the reader would refuse is never written (#7805 review, L1).
  if (value.length > MAX_SEALED_LENGTH) throw new SealedCookieTooLarge();
  return value;
}

/** The plaintext, or undefined when the value does not open under this key, label and name. */
export function openCookieValue(secret: string, label: string, name: string, value: string): string | undefined {
  if (!value || value.length > MAX_SEALED_LENGTH) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(secret, label), bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Every value the raw `Cookie` header carries under exactly this name (two copies refuse at the caller). */
export function cookieCopies(cookieHeader: string | null, name: string): string[] {
  return (cookieHeader ?? '')
    .split(';')
    .map((pair) => pair.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((pair) => pair.slice(0, pair.indexOf('=')) === name)
    .map((pair) => pair.slice(pair.indexOf('=') + 1));
}
