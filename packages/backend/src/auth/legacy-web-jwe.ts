import { hkdf } from '@panva/hkdf';
import { jwtDecrypt } from 'jose';

let cachedEncryptionKey: Uint8Array | null = null;
let cachedSecret: string | null = null;

/** The released NextAuth v4 key derivation. No credential or lineage authority. */
export async function decryptLegacyWebJwe(token: string, secret: string, clockTolerance: number, currentDate?: Date) {
  if (!cachedEncryptionKey || cachedSecret !== secret) {
    cachedEncryptionKey = await hkdf(
      'sha256',
      new TextEncoder().encode(secret),
      '',
      'NextAuth.js Generated Encryption Key',
      32,
    );
    cachedSecret = secret;
  }
  // Existing readers retain their own clock. A transaction-bound writer supplies
  // actual database time, preserving JOSE's claim/tolerance semantics unchanged.
  return jwtDecrypt(token, cachedEncryptionKey, { clockTolerance, ...(currentDate ? { currentDate } : {}) });
}
