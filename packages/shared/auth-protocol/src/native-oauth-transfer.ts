import { z } from 'zod';
import { webCredentialProofSchema, type WebCredentialProof } from './web-credential-proof';
import type { NativeOAuthAttemptCrypto } from './native-oauth-attempt';

/** Browser fallback only. Native exchange keeps its separate replay/ancestry contract. */
export const NATIVE_OAUTH_TRANSFER_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 5;
const MAX_LIFETIME_SECONDS = NATIVE_OAUTH_TRANSFER_TTL_SECONDS + CLOCK_SKEW_SECONDS;
const SPENT_MARKER_MARGIN_SECONDS = 300;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface VerifiedBrowserNativeTransfer {
  readonly userId: string;
  readonly nextPath: string;
  readonly generation: number;
  readonly credentialProof?: WebCredentialProof;
  /** First millisecond the inclusive integer-seconds verifier refuses. Not authentication age. */
  readonly validUntil: number;
  readonly accountCreation?: unknown;
  readonly authSessionId?: unknown;
  readonly attemptId?: unknown;
  readonly provider?: unknown;
}

/** Exact browser signer/verifier and existing durable marker recipe, with platform crypto injected. */
export function createNativeOAuthTransferCodec(crypto: NativeOAuthAttemptCrypto) {
  function signedPayload(token: string, secret: string): string | null {
    if (!secret) return null;
    const segments = token.split('.');
    if (segments.length !== 2) return null;
    const [encodedPayload, signature] = segments;
    if (!SEGMENT.test(encodedPayload) || !SEGMENT.test(signature)) return null;
    return crypto.equal(signature, crypto.hmac(encodedPayload, secret)) ? encodedPayload : null;
  }

  function readNativeOAuthTransfer(token: string, secret: string, nowMs: number): VerifiedBrowserNativeTransfer | null {
    try {
      const encodedPayload = signedPayload(token, secret);
      if (!encodedPayload || !Number.isSafeInteger(nowMs)) return null;
      const decoded: unknown = JSON.parse(crypto.decode(encodedPayload));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
      const payload = decoded as Record<string, unknown>;
      const { userId, nextPath, iat, exp, gen } = payload;
      const now = Math.floor(nowMs / 1000);
      if (
        typeof userId !== 'string' ||
        !userId ||
        typeof nextPath !== 'string' ||
        !nextPath ||
        typeof iat !== 'number' ||
        !iat ||
        !Number.isSafeInteger(iat) ||
        typeof exp !== 'number' ||
        !exp ||
        !Number.isSafeInteger(exp) ||
        exp <= iat ||
        exp - iat > MAX_LIFETIME_SECONDS ||
        exp < now - CLOCK_SKEW_SECONDS ||
        iat > now + CLOCK_SKEW_SECONDS
      )
        return null;
      if (gen !== undefined && (typeof gen !== 'number' || !Number.isSafeInteger(gen) || gen < 0)) return null;
      let credentialProof: WebCredentialProof | undefined;
      if (
        (gen !== undefined && payload.authSessionId !== undefined) ||
        payload.auth_time !== undefined ||
        payload.link_guarded !== undefined ||
        payload.legacy_no_sid !== undefined
      ) {
        const authTime = payload.auth_time;
        if (
          authTime !== undefined &&
          (typeof authTime !== 'number' ||
            !Number.isSafeInteger(authTime) ||
            authTime <= 0 ||
            authTime > now + CLOCK_SKEW_SECONDS)
        )
          return null;
        const parsed = webCredentialProofSchema.safeParse({
          version: 1,
          userId,
          authSessionId: payload.authSessionId,
          generation: gen,
          authenticatedAt: authTime === undefined ? null : new Date(authTime * 1000).toISOString(),
          linkGuarded: payload.link_guarded === true,
          ...(payload.legacy_no_sid !== undefined ? { requiresAccountCutoff: payload.legacy_no_sid } : {}),
        });
        if (!parsed.success) return null;
        credentialProof = parsed.data;
      }
      return {
        userId,
        nextPath: nextPath.startsWith('/') ? nextPath : '/',
        generation: gen ?? 0,
        validUntil: (exp + CLOCK_SKEW_SECONDS + 1) * 1000,
        ...(credentialProof ? { credentialProof } : {}),
        accountCreation: payload.accountCreation,
        authSessionId: payload.authSessionId,
        attemptId: payload.attemptId,
        provider: payload.provider,
      };
    } catch {
      return null;
    }
  }

  /** Signature/expiry-derived claim only: callers must also run the full verifier. */
  function nativeOAuthTransferSpentMarker(token: string, secret: string) {
    try {
      const encodedPayload = signedPayload(token, secret);
      if (!encodedPayload) return null;
      const decoded: unknown = JSON.parse(crypto.decode(encodedPayload));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
      const exp = (decoded as Record<string, unknown>).exp;
      if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return null;
      const digest = crypto.hash(`native-oauth-transfer-v1\0${encodedPayload}`);
      return {
        identifier: `ba03-web-auth:${digest}`,
        token: digest,
        expires: new Date((exp + CLOCK_SKEW_SECONDS + SPENT_MARKER_MARGIN_SECONDS) * 1000),
      };
    } catch {
      return null;
    }
  }
  return Object.freeze({ readNativeOAuthTransfer, nativeOAuthTransferSpentMarker });
}

export const NATIVE_TRANSFER_PROTOCOL_VERSION = 1;
export const NATIVE_TRANSFER_COMMAND_PATH = '/api/internal/auth/current-store/native-transfer';
export const NATIVE_TRANSFER_REQUEST_BYTES = 65_536;
const requestId = z.uuidv4();
const commandMetadata = {
  nativeTransferProtocolVersion: z.literal(NATIVE_TRANSFER_PROTOCOL_VERSION),
  operation: z.literal('claim'),
  requestId,
};
export const nativeTransferCommandSchema = z
  .object({
    ...commandMetadata,
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    payload: z.object({ transferToken: z.string().min(1).max(32_768) }).strict(),
  })
  .strict();
export const nativeTransferReplySchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...commandMetadata,
      outcome: z.literal('claimed'),
      user: z
        .object({ id: z.string().min(1), email: z.string(), name: z.string().nullable(), image: z.string().nullable() })
        .strict(),
      sourceGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      credentialProof: webCredentialProofSchema.optional(),
    })
    .strict()
    .refine(
      (reply) =>
        !reply.credentialProof ||
        (reply.credentialProof.userId === reply.user.id && reply.credentialProof.generation === reply.sourceGeneration),
    ),
  z.object({ ...commandMetadata, outcome: z.literal('denied') }).strict(),
  z.object({ ...commandMetadata, outcome: z.literal('unavailable') }).strict(),
]);
export type NativeTransferCommand = z.infer<typeof nativeTransferCommandSchema>;
export type NativeTransferReply = z.infer<typeof nativeTransferReplySchema>;
export function nativeTransferReplyStatus(reply: NativeTransferReply): number {
  return reply.outcome === 'unavailable' ? 503 : reply.outcome === 'denied' ? 401 : 200;
}
