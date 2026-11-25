/** Server-to-server attribution only. These proofs never authenticate a user. */
import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

export const CATALOG_PROOF_HEADER = 'x-boardsesh-catalog-proof';
export const CATALOG_ADMISSION_PATH = '/internal/catalog-admission';
const PROOF_LIFETIME_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;
const MAX_PROOF_LENGTH = 2048;

export type CatalogProofPurpose = 'graphql' | 'reserve' | 'release';

export type CatalogProofInput = {
  purpose: CatalogProofPurpose;
  method: string;
  pathname: string;
  clientIp: string;
  /** Admission commands bind their complete JSON body; GraphQL proves attribution only. */
  body?: string;
};

type CatalogProofPayload = Omit<CatalogProofInput, 'body'> & {
  bodyHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function signingKey(secret: string): Buffer {
  if (!secret) throw new Error('Catalog attribution requires NEXTAUTH_SECRET');
  return Buffer.from(hkdfSync('sha256', secret, '', 'boardsesh-catalog-attribution-v1', 32));
}

function bodyHash(body: string | undefined): string {
  return createHash('sha256')
    .update(body ?? '')
    .digest('hex');
}

export function signCatalogRequest(input: CatalogProofInput, secret: string, now = Date.now()): string {
  if (!input.clientIp || input.clientIp.length > 128) throw new Error('Invalid catalog attribution identity');
  const { body, ...attribution } = input;
  const payload: CatalogProofPayload = {
    ...attribution,
    bodyHash: bodyHash(body),
    issuedAt: now,
    expiresAt: now + PROOF_LIFETIME_MS,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey(secret)).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyCatalogRequest(
  token: string | null | undefined,
  expected: Omit<CatalogProofInput, 'clientIp'>,
  secret: string | undefined,
  now = Date.now(),
): { clientIp: string } | null {
  if (!secret || !token || token.length > MAX_PROOF_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [encoded, signature] = parts;
  const actual = Buffer.from(signature, 'base64url');
  const wanted = createHmac('sha256', signingKey(secret)).update(encoded).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const proof = payload as Record<string, unknown>;
  if (
    proof.purpose !== expected.purpose ||
    proof.method !== expected.method ||
    proof.pathname !== expected.pathname ||
    proof.bodyHash !== bodyHash(expected.body) ||
    typeof proof.clientIp !== 'string' ||
    proof.clientIp.length === 0 ||
    proof.clientIp.length > 128 ||
    typeof proof.nonce !== 'string' ||
    typeof proof.issuedAt !== 'number' ||
    !Number.isSafeInteger(proof.issuedAt) ||
    typeof proof.expiresAt !== 'number' ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt - proof.issuedAt !== PROOF_LIFETIME_MS ||
    proof.issuedAt > now + CLOCK_SKEW_MS ||
    proof.expiresAt <= now - CLOCK_SKEW_MS
  ) {
    return null;
  }
  return { clientIp: proof.clientIp };
}
