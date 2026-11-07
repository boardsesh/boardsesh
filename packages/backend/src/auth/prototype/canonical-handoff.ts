import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeDatabase } from './authority';
import { createPrototypeNativeFacade } from './identity-native-facade';
import { prototypeCredentialFailureWithoutCookies } from './credential-continuation';
import { prototypeSessionPassesRevocation } from './session-revocation';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { PrototypeResponseRollback } from './transaction-response';

export const PROTOTYPE_CANONICAL_HANDOFF_PATHS = {
  issue: '/prototype-canonical-handoff/issue',
  exchange: '/prototype-canonical-handoff/exchange',
} as const;
export const PROTOTYPE_CANONICAL_HANDOFF_PREFIX = 'prototype-canonical-handoff:';
const PURPOSE = 'canonical-browser-native-handoff';
const TYPE = 'boardsesh-canonical-handoff+jwt';
const AUDIENCE = 'boardsesh-prototype-native-handoff';
const LIFETIME_MS = 120_000;

const bindingSchema = z.strictObject({
  purpose: z.literal(PURPOSE),
  version: z.literal(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  nonceHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  consumedAt: z.iso.datetime().nullable(),
});

interface PrototypeCanonicalHandoffOptions {
  readonly authority?: BetterAuthOptions;
  /** Trusted fault injection only; public input cannot choose these callbacks. */
  readonly afterIssued?: () => Promise<void>;
  readonly afterMint?: () => Promise<void>;
}

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidHandoff(): APIError {
  return new APIError('UNAUTHORIZED', { code: 'INVALID_HANDOFF', message: 'Invalid or expired handoff' });
}

async function liveSource(transaction: PrototypeTransaction, userId: string, sessionId: string, token?: string) {
  const [source] = await transaction
    .select({ session: schema.session })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, userId)));
  const [cutoff] = await transaction
    .select()
    .from(schema.prototypeUserCutoff)
    .where(eq(schema.prototypeUserCutoff.userId, userId));
  if (
    !source ||
    (token !== undefined && token !== source.session.token) ||
    source.session.expiresAt.getTime() <= Date.now() ||
    !prototypeSessionPassesRevocation(source.session, cutoff)
  )
    throw invalidHandoff();
  return { session: source.session, generation: cutoff?.generation ?? 0 };
}

/**
 * Future canonical browser producer capability only; no production route mounts
 * this handler. Its dedicated key and format are never legacy credentials.
 * The existing native issuer owns token policy; this adapter only proves source.
 */
export function createPrototypeCanonicalHandoff(
  database: PrototypeDatabase,
  handoffSigningKey: Uint8Array,
  nativeSigningKey: Uint8Array,
  options: PrototypeCanonicalHandoffOptions = {},
) {
  // Copy trusted caller-owned buffers before any await. Dedicated keys prevent
  // a native access token from being mistaken for this purpose-specific proof.
  const key = new Uint8Array(handoffSigningKey);
  const nativeKey = new Uint8Array(nativeSigningKey);
  if (key.length < 32 || (key.length === nativeKey.length && timingSafeEqual(key, nativeKey)))
    throw new Error('The handoff requires its own synthetic signing key of at least 32 bytes.');
  const native = createPrototypeNativeFacade(database, nativeKey);

  return {
    async handler(request: Request): Promise<Response> {
      const method = request.method;
      const url = request.url;
      const headers = new Headers(request.headers);
      const path = new URL(url).pathname;
      if (
        !Object.values(PROTOTYPE_CANONICAL_HANDOFF_PATHS).some(
          (suffix) => path === `${new URL(PROTOTYPE_ISSUER).pathname}${suffix}`,
        )
      )
        return new Response(null, { status: 404 });
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await request.clone().text();
      const captured = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
      try {
        return await native.withIssuanceTransaction(async (transaction, issueForSession) => {
          const plugin: BetterAuthPlugin = {
            id: 'boardsesh-prototype-canonical-handoff',
            endpoints: {
              prototypeIssueCanonicalHandoff: createAuthEndpoint(
                PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue,
                { method: 'POST', body: z.strictObject({}), use: [sensitiveSessionMiddleware] },
                async (context) => {
                  const authenticated = context.context.session;
                  if (!authenticated) throw invalidHandoff();
                  const source = await liveSource(
                    transaction,
                    authenticated.user.id,
                    authenticated.session.id,
                    authenticated.session.token,
                  );
                  const issuedAt = new Date();
                  const issuedAtMs = issuedAt.getTime();
                  const expiresAtMs = issuedAtMs + LIFETIME_MS;
                  const nonce = randomBytes(32).toString('hex');
                  const binding = {
                    purpose: PURPOSE,
                    version: 1 as const,
                    userId: source.session.userId,
                    sessionId: source.session.id,
                    generation: source.generation,
                    nonceHash: hash(nonce),
                    issuedAtMs,
                    expiresAtMs,
                    consumedAt: null,
                  };
                  const transferToken = await new SignJWT({
                    purpose: PURPOSE,
                    version: 1,
                    sid: binding.sessionId,
                    generation: binding.generation,
                    nonce,
                    issuedAtMs,
                    expiresAtMs,
                  })
                    .setProtectedHeader({ alg: 'HS256', typ: TYPE })
                    .setSubject(binding.userId)
                    .setIssuer(PROTOTYPE_ISSUER)
                    .setAudience(AUDIENCE)
                    .setIssuedAt(Math.floor(issuedAtMs / 1000))
                    // Standard exp encloses the millisecond bound. Redemption
                    // additionally enforces the exact signed/receipt deadline.
                    .setExpirationTime(Math.ceil(expiresAtMs / 1000))
                    .sign(key);
                  const identifier = `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}${hash(transferToken)}`;
                  await transaction.insert(schema.verification).values({
                    id: identifier,
                    identifier,
                    value: JSON.stringify(binding),
                    expiresAt: new Date(expiresAtMs),
                  });
                  await options.afterIssued?.();
                  context.setHeader('cache-control', 'no-store');
                  return context.json({ transferToken, expiresAt: new Date(expiresAtMs).toISOString() });
                },
              ),
              prototypeExchangeCanonicalHandoff: createAuthEndpoint(
                PROTOTYPE_CANONICAL_HANDOFF_PATHS.exchange,
                { method: 'POST', body: z.strictObject({ transferToken: z.string().min(1).max(4096) }) },
                async (context) => {
                  const now = new Date();
                  let claims;
                  try {
                    const verified = await jwtVerify(context.body.transferToken, key, {
                      algorithms: ['HS256'],
                      typ: TYPE,
                      issuer: PROTOTYPE_ISSUER,
                      audience: AUDIENCE,
                      requiredClaims: [
                        'sub',
                        'sid',
                        'iat',
                        'exp',
                        'purpose',
                        'version',
                        'generation',
                        'nonce',
                        'issuedAtMs',
                        'expiresAtMs',
                      ],
                      currentDate: now,
                    });
                    claims = z
                      .strictObject({
                        sub: z.string().min(1),
                        sid: z.string().min(1),
                        iss: z.literal(PROTOTYPE_ISSUER),
                        aud: z.literal(AUDIENCE),
                        iat: z.number().int(),
                        exp: z.number().int(),
                        purpose: z.literal(PURPOSE),
                        version: z.literal(1),
                        generation: z.number().int().nonnegative(),
                        nonce: z.string().regex(/^[0-9a-f]{64}$/),
                        issuedAtMs: z.number().int().nonnegative(),
                        expiresAtMs: z.number().int().positive(),
                      })
                      .parse(verified.payload);
                  } catch {
                    throw invalidHandoff();
                  }
                  if (
                    claims.expiresAtMs - claims.issuedAtMs !== LIFETIME_MS ||
                    claims.issuedAtMs > now.getTime() ||
                    claims.expiresAtMs <= now.getTime() ||
                    claims.iat !== Math.floor(claims.issuedAtMs / 1000) ||
                    claims.exp !== Math.ceil(claims.expiresAtMs / 1000)
                  )
                    throw invalidHandoff();
                  const identifier = `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}${hash(context.body.transferToken)}`;
                  const [receipt] = await transaction
                    .select()
                    .from(schema.verification)
                    .where(eq(schema.verification.id, identifier))
                    .for('update');
                  let binding;
                  try {
                    binding = bindingSchema.parse(JSON.parse(receipt?.value ?? 'null'));
                  } catch {
                    throw invalidHandoff();
                  }
                  if (
                    !receipt ||
                    receipt.identifier !== identifier ||
                    binding.consumedAt !== null ||
                    receipt.expiresAt.getTime() !== claims.expiresAtMs ||
                    binding.expiresAtMs !== claims.expiresAtMs ||
                    binding.issuedAtMs !== claims.issuedAtMs ||
                    binding.userId !== claims.sub ||
                    binding.sessionId !== claims.sid ||
                    binding.generation !== claims.generation ||
                    binding.nonceHash !== hash(claims.nonce)
                  )
                    throw invalidHandoff();
                  const source = await liveSource(transaction, binding.userId, binding.sessionId);
                  if (source.generation !== binding.generation) throw invalidHandoff();
                  const actor = await getAuthoritativeSessionFromCtx(context);
                  if (actor) {
                    await liveSource(transaction, actor.user.id, actor.session.id, actor.session.token);
                    if (actor.user.id !== binding.userId || actor.session.id !== binding.sessionId)
                      throw new APIError('FORBIDDEN', { code: 'ACCOUNT_MISMATCH' });
                  }
                  // Database/actor reads can themselves wait. Authorization
                  // cannot outlive the exact deadline before native issuance.
                  if (binding.expiresAtMs <= Date.now()) throw invalidHandoff();
                  await transaction
                    .update(schema.verification)
                    .set({
                      value: JSON.stringify({ ...binding, consumedAt: now.toISOString() }),
                    })
                    .where(eq(schema.verification.id, identifier));
                  const pair = await issueForSession(binding.userId, binding.sessionId);
                  await options.afterMint?.();
                  context.setHeader('cache-control', 'no-store');
                  return context.json(pair);
                },
              ),
            },
          };
          const authority = createPrototypeAuthority(transaction, {
            ...options.authority,
            advanced: { ...options.authority?.advanced, disableOriginCheck: false, disableCSRFCheck: false },
            plugins: [plugin, ...(options.authority?.plugins ?? [])],
          });
          const response = await authority.handler(captured);
          if (!response.ok) throw new PrototypeResponseRollback(response);
          return response;
        });
      } catch (error) {
        if (error instanceof PrototypeResponseRollback) return prototypeCredentialFailureWithoutCookies(error.response);
        throw error;
      }
    },
  };
}
