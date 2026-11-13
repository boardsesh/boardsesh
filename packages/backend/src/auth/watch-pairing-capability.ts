import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { AuthResult } from '../middleware/auth';
import { verifyLegacyNextAuthJwe } from './legacy-web-credentials';
import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { nativeSessionRequiresAccountCutoff } from './native-session-ancestry';

export const WATCH_PAIR_CAPABILITY_TTL_SECONDS = 300;
const generation = z.number().int().nonnegative().safe();
const sourceFields = {
  generation,
  authSessionId: z.string().min(1).max(256).nullable(),
  authenticatedAt: z.number().int().positive().safe().nullable(),
  requiresAccountCutoff: z.boolean(),
  expiresAt: z.number().int().positive().safe(),
};
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ ...sourceFields, kind: z.literal('web') }).strict(),
  z.object({ ...sourceFields, kind: z.literal('native'), nativeGeneration: generation }).strict(),
]);
const capabilitySchema = z
  .object({
    version: z.literal(2),
    nonce: z.uuidv4(),
    userId: z.string().min(1).max(256),
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    source: sourceSchema,
  })
  .strict()
  .refine((capability) => {
    const source = capability.source;
    const ancestry = source.authSessionId === null ? true : nativeSessionRequiresAccountCutoff(source.authSessionId);
    return (
      ancestry !== null &&
      (!ancestry || source.requiresAccountCutoff) &&
      capability.expiresAt > capability.issuedAt &&
      capability.expiresAt <= source.expiresAt &&
      capability.expiresAt - capability.issuedAt <= WATCH_PAIR_CAPABILITY_TTL_SECONDS * 1000 &&
      (source.authenticatedAt === null || source.authenticatedAt * 1000 <= capability.issuedAt + 5_000)
    );
  });
export type WatchPairCapability = z.infer<typeof capabilitySchema>;

export function parseWatchPairCapability(contents: string, now = Date.now()): WatchPairCapability | null {
  if (Buffer.byteLength(contents, 'utf8') > 4096) return null;
  try {
    const parsed = capabilitySchema.safeParse(JSON.parse(contents) as unknown);
    return parsed.success && parsed.data.issuedAt <= now + 5_000 && parsed.data.expiresAt > now ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reverify the exact admitted bytes; neither displayed session fields nor code time prove authentication. */
export async function createWatchPairCapability(
  admittedInput: AuthResult,
  credential: string,
  verificationSecret: string,
  now = Date.now(),
): Promise<{ contents: string; ttlSeconds: number; capability: WatchPairCapability } | null> {
  const admitted = { userId: admittedInput.userId, credential: { ...admittedInput.credential } };
  let source: WatchPairCapability['source'];
  if (admitted.credential.kind === 'web-session') {
    const proof = await verifyLegacyNextAuthJwe(credential, verificationSecret, new Date(now));
    if (!proof || proof.userId !== admitted.userId || proof.generation !== (admitted.credential.generationClaim ?? 0))
      return null;
    source = {
      kind: 'web',
      generation: proof.generation,
      authSessionId: proof.authSessionId,
      authenticatedAt:
        proof.linkGuarded && proof.originalAuthenticatedAt ? proof.originalAuthenticatedAt.getTime() / 1000 : null,
      requiresAccountCutoff: proof.requiresAccountCutoff,
      expiresAt: proof.expiresAt.getTime(),
    };
  } else if (admitted.credential.kind === 'native-access') {
    try {
      const { payload } = await jwtVerify(credential, new TextEncoder().encode(verificationSecret), {
        issuer: 'boardsesh',
        audience: 'boardsesh-mobile',
        algorithms: ['HS256'],
        clockTolerance: 60,
        currentDate: new Date(now),
      });
      if (payload.legacy_no_sid !== undefined && payload.legacy_no_sid !== true) return null;
      const subjectGeneration = payload.gen ?? 0;
      const nativeGeneration = payload.ngen ?? 0;
      const parsedGeneration = generation.safeParse(subjectGeneration),
        parsedNativeGeneration = generation.safeParse(nativeGeneration);
      if (
        payload.sub !== admitted.userId ||
        !parsedGeneration.success ||
        !parsedNativeGeneration.success ||
        subjectGeneration !== (admitted.credential.generationClaim ?? 0) ||
        nativeGeneration !== (admitted.credential.nativeGenerationClaim ?? 0) ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp)
      )
        return null;
      if (
        payload.sid !== undefined &&
        (typeof payload.sid !== 'string' || nativeSessionRequiresAccountCutoff(payload.sid) === null)
      )
        return null;
      const sessionId = typeof payload.sid === 'string' ? payload.sid : null;
      source = {
        kind: 'native',
        generation: parsedGeneration.data,
        nativeGeneration: parsedNativeGeneration.data,
        authSessionId: sessionId,
        requiresAccountCutoff:
          payload.legacy_no_sid === true ||
          sessionId === null ||
          nativeSessionRequiresAccountCutoff(sessionId) === true,
        authenticatedAt: readAuthTimeClaim(payload.auth_time, now),
        expiresAt: payload.exp * 1000,
      };
    } catch {
      return null;
    }
  } else return null;
  const issuedAt = Date.now();
  const ttlSeconds = Math.min(WATCH_PAIR_CAPABILITY_TTL_SECONDS, Math.floor((source.expiresAt - issuedAt) / 1000));
  if (ttlSeconds < 1) return null;
  const capability = capabilitySchema.parse({
    version: 2,
    nonce: randomUUID(),
    userId: admitted.userId,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1000,
    source,
  });
  return { contents: JSON.stringify(capability), ttlSeconds, capability };
}
