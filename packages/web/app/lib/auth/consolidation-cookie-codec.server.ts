import 'server-only';
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { encode as ordinaryEncode } from 'next-auth/jwt';
import type { JWTEncodeParams } from 'next-auth/jwt';

/** Released NextAuth v4 JWE format, with the transferred proof's fixed clock bounds. */
export async function encodeConsolidationCookie(parameters: JWTEncodeParams): Promise<string> {
  const { token, secret } = parameters;
  if (!token?.accountConsolidation) return ordinaryEncode(parameters);
  const issuedAt = token.accountConsolidationIssuedAt;
  const expiresAt = token.accountConsolidationExpiresAt;
  if (
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() / 1000 ||
    issuedAt > expiresAt ||
    issuedAt > Date.now() / 1000
  )
    throw new Error('Consolidation cookie proof unavailable');
  const key = hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32);
  const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
  cipher.setAAD(Buffer.from(header));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ ...token, iat: issuedAt, exp: expiresAt, jti: randomUUID() })),
    cipher.final(),
  ]);
  return [
    header,
    '',
    nonce.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}
