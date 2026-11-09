import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';
import { and, eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { createPrototypeNativeFacade } from './identity-native-facade';
import { hasPrototypeLegacySourceDenial } from './legacy-source-state';

export const PROTOTYPE_TRANSFER_CLOCK_TOLERANCE_SECONDS = 5;
const MAX_TRANSFER_TOKEN_LIFETIME_SECONDS = 125;
const MAX_TRANSFER_TOKEN_LENGTH = 4096;
const CONSUMED_PREFIX = 'prototype-native-transfer:';

export interface VerifiedPrototypeLegacyTransfer {
  readonly userId: string;
  readonly nextPath: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly validUntil: Date;
  readonly originalAuthenticatedAt: null;
  readonly authSessionId: string | null;
  readonly attemptId: string | null;
  readonly provider: 'apple' | 'google' | null;
  readonly fingerprint: string;
  readonly accountCreation?: AccountCreationReceipt;
}

export class PrototypeLegacyTransferError extends Error {
  constructor(readonly status: 401 | 409) {
    super(status === 409 ? 'Transfer token has already been used' : 'Invalid or expired transfer token');
    this.name = 'PrototypeLegacyTransferError';
  }
}

function nextPath(path: string): string {
  const unsafeCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === '\\';
  });
  return path.startsWith('/') && !path.startsWith('//') && !unsafeCharacter ? path : '/';
}

/** Exact legacy two-part HMAC transport, deliberately separate from JWT, attempts and other purposes. */
export function verifyPrototypeLegacyTransfer(
  token: unknown,
  verificationSecret: string,
  currentTime = new Date(),
): VerifiedPrototypeLegacyTransfer | null {
  if (
    typeof token !== 'string' ||
    !verificationSecret ||
    token.length > MAX_TRANSFER_TOKEN_LENGTH ||
    !Number.isFinite(currentTime.getTime())
  )
    return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]))
    return null;
  const [encodedPayload, signature] = parts;
  const expected = createHmac('sha256', verificationSecret).update(encodedPayload).digest('base64url');
  // Compare the canonical text, not permissively decoded base64 aliases that
  // could produce another replay fingerprint for the same valid signature.
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  const now = Math.floor(currentTime.getTime() / 1000);
  if (
    typeof payload.userId !== 'string' ||
    !payload.userId.trim() ||
    payload.userId.length > 256 ||
    typeof payload.nextPath !== 'string' ||
    !payload.nextPath ||
    payload.nextPath.length > 2048 ||
    typeof payload.iat !== 'number' ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat <= 0 ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TRANSFER_TOKEN_LIFETIME_SECONDS ||
    payload.exp < now - PROTOTYPE_TRANSFER_CLOCK_TOLERANCE_SECONDS ||
    payload.iat > now + PROTOTYPE_TRANSFER_CLOCK_TOLERANCE_SECONDS ||
    payload.kind !== undefined ||
    payload.purpose !== undefined ||
    payload.token_use !== undefined ||
    payload.iss !== undefined ||
    payload.aud !== undefined
  )
    return null;

  const authSessionId =
    typeof payload.authSessionId === 'string' &&
    payload.authSessionId.trim().length > 0 &&
    payload.authSessionId.length <= 256
      ? payload.authSessionId
      : null;
  const attemptId =
    typeof payload.attemptId === 'string' && /^[0-9a-f]{32}$/.test(payload.attemptId) ? payload.attemptId : null;
  const provider = payload.provider === 'apple' || payload.provider === 'google' ? payload.provider : null;
  const receipt = parseAccountCreationReceipt(payload.accountCreation);
  const accountCreation =
    receipt && receipt.userId === payload.userId && receipt.provider === provider && authSessionId && attemptId
      ? receipt
      : undefined;
  return {
    userId: payload.userId,
    nextPath: nextPath(payload.nextPath),
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    // The installed verifier compares integer seconds inclusively. Retain the
    // complete last accepted second, so cleanup cannot open a replay gap.
    validUntil: new Date((payload.exp + PROTOTYPE_TRANSFER_CLOCK_TOLERANCE_SECONDS + 1) * 1000),
    originalAuthenticatedAt: null,
    authSessionId,
    attemptId,
    provider,
    fingerprint: createHash('sha256').update(token).digest('hex'),
    ...(accountCreation ? { accountCreation } : {}),
  };
}

/**
 * Disposable browser-fallback proof. No product router uses these synthetic
 * keys or this adapter. The transfer's recent iat never becomes a fresh login.
 */
export function createPrototypeLegacyTransferFacade(
  database: PrototypeDatabase,
  verificationSecret: string,
  nativeSigningKey: Uint8Array,
  afterMutation?: () => Promise<void>,
) {
  const native = createPrototypeNativeFacade(database, nativeSigningKey);
  async function exchange(token: unknown) {
    const proof = verifyPrototypeLegacyTransfer(token, verificationSecret);
    if (!proof) throw new PrototypeLegacyTransferError(401);
    return native.withIssuanceTransaction(async (transaction, issueForSession) => {
      const now = Date.now();
      if (proof.validUntil.getTime() <= now) throw new PrototypeLegacyTransferError(401);
      const consumedId = `${CONSUMED_PREFIX}${proof.fingerprint}`;
      const [consumed] = await transaction
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, consumedId));
      if (consumed) throw new PrototypeLegacyTransferError(409);
      const [user] = await transaction.select().from(schema.user).where(eq(schema.user.id, proof.userId));
      const [cutoff] = await transaction
        .select()
        .from(schema.prototypeUserCutoff)
        .where(eq(schema.prototypeUserCutoff.userId, proof.userId));
      if (!user) throw new PrototypeLegacyTransferError(401);

      const lineageId = proof.authSessionId
        ? `session:${createHash('sha256')
            .update(JSON.stringify(['nextauth-v4', proof.userId, proof.authSessionId]))
            .digest('hex')}`
        : `credential:transfer:${proof.fingerprint}`;
      const [lineage] = await transaction
        .select()
        .from(schema.prototypeLegacyLineage)
        .where(eq(schema.prototypeLegacyLineage.id, lineageId));
      let sessionId: string;
      if (lineage) {
        const [canonical] = await transaction
          .select()
          .from(schema.session)
          .where(and(eq(schema.session.id, lineage.sessionId), eq(schema.session.userId, proof.userId)));
        if (lineage.userId !== proof.userId || lineage.revokedAt || !canonical || canonical.expiresAt.getTime() <= now)
          throw new PrototypeLegacyTransferError(401);
        sessionId = canonical.id;
      } else {
        // Released returning-user transfers omit their browser session ID.
        // Their new iat cannot prove that browser authentication followed a
        // reset or signout. Ambiguous provenance requires reauthentication.
        if (cutoff || (await hasPrototypeLegacySourceDenial(transaction, proof.userId)))
          throw new PrototypeLegacyTransferError(401);
        sessionId = randomUUID();
        await transaction.insert(schema.session).values({
          id: sessionId,
          userId: proof.userId,
          token: randomBytes(32).toString('hex'),
          createdAt: new Date(0),
          updatedAt: new Date(now),
          expiresAt: proof.validUntil,
          originalAuthenticatedAt: null,
          legacyLineageId: lineageId,
        });
        await transaction.insert(schema.prototypeLegacyLineage).values({
          id: lineageId,
          userId: proof.userId,
          sessionId,
          originalAuthenticatedAt: null,
          originalExpiresAt: proof.expiresAt,
        });
      }
      await transaction.insert(schema.verification).values({
        id: consumedId,
        identifier: consumedId,
        expiresAt: proof.validUntil,
        value: JSON.stringify({
          type: 'prototype-native-transfer-consumed',
          userId: proof.userId,
          lineageId,
          attemptId: proof.attemptId,
          provider: proof.provider,
        }),
      });
      const pair = await issueForSession(proof.userId, sessionId);
      await afterMutation?.();
      return { ...pair, ...(proof.accountCreation ? { accountCreation: proof.accountCreation } : {}) };
    });
  }
  return { exchange };
}
