import { createHash, randomBytes } from 'node:crypto';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx, sendVerificationEmailFn } from 'better-auth/api';
import { eq, sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import { normalizeAccountEmail } from '../normalize-email';
import { createPrototypeAuthority, type PrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { PrototypeResponseRollback } from './transaction-response';
import {
  invalidatePrototypeCanonicalVerification,
  parsePrototypeVerificationBinding,
  PROTOTYPE_CANONICAL_VERIFICATION_PREFIX,
  type PrototypeVerificationBinding,
} from './verification-state';

export const PROTOTYPE_VERIFICATION_PATHS = {
  send: '/prototype-canonical-verification/send',
  verify: '/prototype-canonical-verification/verify',
} as const;
const VERIFICATION_LIFETIME_SECONDS = 3600;
// The actual producer reads constructor time for iat and Date.now separately
// for exp. This bounds encoder pauses only; signed exp gets zero expiry grace.
export const PROTOTYPE_VERIFICATION_ENCODER_READ_ALLOWANCE_SECONDS = 60;
const MAX_NONCE_ATTEMPTS = 5;
const SEND_MINIMUM_MS = 500;

export interface PrototypeVerificationMessage {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
  readonly nonce: string;
  readonly url: string;
  readonly expiresAt: Date;
}

interface PrototypeVerificationOptions {
  readonly onVerificationIssued: (message: PrototypeVerificationMessage) => void | Promise<void>;
  readonly authority?: BetterAuthOptions;
  /** Trusted deterministic fault injection only, never request input. */
  readonly createNonce?: () => string;
}

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];

async function normalizedOwners(transaction: PrototypeTransaction, email: string) {
  // Disposable-fixture scan only. SQL lower/btrim does not implement JavaScript
  // trim/toLowerCase for every historical Unicode/whitespace input. Production
  // needs the BA-02 normalized index and writer reservation; never truncate this
  // scan before checking all owners under the shared pure identity policy.
  const users = await transaction.select().from(schema.user);
  return users.filter((user) => normalizeAccountEmail(user.email) === email);
}

function receiptIdentifier(token: string, nonce: string): string {
  return `${PROTOTYPE_CANONICAL_VERIFICATION_PREFIX}${createHash('sha256')
    .update(JSON.stringify([token, nonce]))
    .digest('hex')}`;
}

function invalidVerification(): APIError {
  return new APIError('BAD_REQUEST', { code: 'INVALID_VERIFICATION', message: 'Invalid or expired verification link' });
}

async function verifiedClaims(token: string, secret: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    requiredClaims: ['userId', 'email', 'iat', 'exp'],
  });
  const parsed = z
    .object({
      userId: z.string().min(1),
      email: z.email(),
      iat: z.number().int().nonnegative(),
      exp: z.number().int().positive(),
      updateTo: z.undefined().optional(),
      requestType: z.undefined().optional(),
      purpose: z.undefined().optional(),
    })
    .parse(payload);
  if (
    parsed.iat * 1000 > Date.now() ||
    parsed.exp <= parsed.iat ||
    parsed.exp - parsed.iat > VERIFICATION_LIFETIME_SECONDS + PROTOTYPE_VERIFICATION_ENCODER_READ_ALLOWANCE_SECONDS ||
    parsed.email !== normalizeAccountEmail(parsed.email)
  )
    throw invalidVerification();
  return { userId: parsed.userId, email: parsed.email, issuedAtSeconds: parsed.iat, expiresAtSeconds: parsed.exp };
}

/**
 * Canonical NEW-link proof only. Legacy link ownership/import remains in
 * legacy-recovery.ts. No product router mounts these receipt-backed endpoints.
 */
export function createPrototypeVerificationLifecycle(
  database: PrototypeDatabase,
  options: PrototypeVerificationOptions,
) {
  const onVerificationIssued = options.onVerificationIssued;
  const createNonce = options.createNonce ?? (() => randomBytes(32).toString('hex'));
  return {
    async handler(request: Request): Promise<Response> {
      // Capture caller-controlled transport before waiting for the lifecycle
      // fence. A mutable Request cannot change owners or tokens while queued.
      const method = request.method;
      const requestUrl = request.url;
      const headers = new Headers(request.headers);
      const path = new URL(requestUrl).pathname;
      const isSend = path === `${new URL(PROTOTYPE_ISSUER).pathname}${PROTOTYPE_VERIFICATION_PATHS.send}`;
      const isVerify = path === `${new URL(PROTOTYPE_ISSUER).pathname}${PROTOTYPE_VERIFICATION_PATHS.verify}`;
      if (!isSend && !isVerify) return new Response(null, { status: 404 });
      const startedAt = performance.now();
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await request.clone().text();
      const captured = new Request(requestUrl, { method, headers, ...(body === undefined ? {} : { body }) });
      const outgoing: PrototypeVerificationMessage[] = [];
      let result: Response;
      try {
        result = await database.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
          let authority: PrototypeAuthority;
          let selectedUserId: string | undefined;
          const plugin: BetterAuthPlugin = {
            id: 'boardsesh-prototype-canonical-verification',
            endpoints: {
              prototypeSendVerification: createAuthEndpoint(
                PROTOTYPE_VERIFICATION_PATHS.send,
                {
                  method: 'POST',
                  body: z.object({ email: z.string().transform(normalizeAccountEmail).pipe(z.email()) }),
                },
                async (context) => {
                  const session = await getSessionFromCtx(context);
                  if (session && normalizeAccountEmail(session.user.email) !== context.body.email)
                    throw new APIError('BAD_REQUEST', { code: 'EMAIL_MISMATCH' });
                  const candidates = await normalizedOwners(transaction, context.body.email);
                  // Never select an arbitrary exact row from a normalized collision.
                  if (candidates.length !== 1) return context.json({ status: true });
                  const selected = candidates[0];
                  if (session && session.user.id !== selected.id)
                    throw new APIError('BAD_REQUEST', { code: 'EMAIL_MISMATCH' });
                  if (selected.emailVerified) return context.json({ status: true });
                  selectedUserId = selected.id;
                  await sendVerificationEmailFn(context, { ...selected, email: context.body.email });
                  return context.json({ status: true });
                },
              ),
              prototypeVerifyEmail: createAuthEndpoint(
                PROTOTYPE_VERIFICATION_PATHS.verify,
                {
                  method: 'GET',
                  query: z.object({ token: z.string().min(1), nonce: z.string().regex(/^[a-f0-9]{64}$/) }),
                },
                async (context) => {
                  let claims: Awaited<ReturnType<typeof verifiedClaims>>;
                  try {
                    claims = await verifiedClaims(context.query.token, context.context.secret);
                  } catch {
                    throw invalidVerification();
                  }
                  const identifier = receiptIdentifier(context.query.token, context.query.nonce);
                  const records = await transaction
                    .select()
                    .from(schema.verification)
                    .where(eq(schema.verification.identifier, identifier))
                    .limit(2)
                    .for('update');
                  const record = records.length === 1 ? records[0] : undefined;
                  const binding = record ? parsePrototypeVerificationBinding(record.value) : null;
                  if (
                    !record ||
                    !binding ||
                    binding.consumedAt ||
                    binding.supersededAt ||
                    record.expiresAt.getTime() <= Date.now() ||
                    record.expiresAt.getTime() !== binding.expiresAtSeconds * 1000 ||
                    binding.userId !== claims.userId ||
                    binding.intendedEmail !== claims.email ||
                    binding.issuedAtSeconds !== claims.issuedAtSeconds ||
                    binding.expiresAtSeconds !== claims.expiresAtSeconds
                  )
                    throw invalidVerification();
                  const boundUserId = binding.userId;
                  const intendedEmail = binding.intendedEmail;
                  const [user] = await transaction.select().from(schema.user).where(eq(schema.user.id, boundUserId));
                  const owners = await normalizedOwners(transaction, intendedEmail);
                  if (
                    !user ||
                    normalizeAccountEmail(user.email) !== intendedEmail ||
                    owners.length !== 1 ||
                    owners[0].id !== user.id
                  )
                    throw invalidVerification();
                  const session = await getSessionFromCtx(context);
                  if (session && session.user.id !== boundUserId)
                    throw new APIError('FORBIDDEN', { code: 'INVALID_USER' });
                  const consumedAt = new Date().toISOString();
                  await transaction
                    .update(schema.verification)
                    .set({ value: JSON.stringify({ ...binding, consumedAt }) })
                    .where(eq(schema.verification.id, record.id));
                  // Update the immutable owner through the same authority. Keep
                  // imported historical timestamp/null semantics unchanged; the
                  // receipt records the actual time this new proof was consumed.
                  if (!user.emailVerified) {
                    await context.context.options.emailVerification?.beforeEmailVerification?.(
                      { ...user },
                      context.request,
                    );
                    const updated = await context.context.internalAdapter.updateUser(boundUserId, {
                      emailVerified: true,
                    });
                    if (
                      !updated ||
                      updated.id !== boundUserId ||
                      normalizeAccountEmail(updated.email) !== intendedEmail
                    )
                      throw new APIError('INTERNAL_SERVER_ERROR');
                    await context.context.options.emailVerification?.afterEmailVerification?.(
                      { ...updated },
                      context.request,
                    );
                    const [finalized] = await transaction
                      .select()
                      .from(schema.user)
                      .where(eq(schema.user.id, boundUserId));
                    if (
                      !finalized ||
                      !finalized.emailVerified ||
                      normalizeAccountEmail(finalized.email) !== intendedEmail
                    )
                      throw new APIError('INTERNAL_SERVER_ERROR');
                  }
                  return context.json({ status: true });
                },
              ),
            },
          };
          authority = createPrototypeAuthority(transaction, {
            ...options.authority,
            advanced: { ...options.authority?.advanced, disableOriginCheck: false, disableCSRFCheck: false },
            emailVerification: {
              ...options.authority?.emailVerification,
              autoSignInAfterVerification: false,
              expiresIn: VERIFICATION_LIFETIME_SECONDS,
              async sendVerificationEmail(message) {
                const userId = message.user.id;
                const email = normalizeAccountEmail(message.user.email);
                const token = message.token;
                const authContext = await authority.$context;
                let claims: Awaited<ReturnType<typeof verifiedClaims>>;
                try {
                  claims = await verifiedClaims(token, authContext.secret);
                } catch {
                  throw new Error('Canonical verification token generation failed');
                }
                if (selectedUserId !== userId || claims.userId !== userId || claims.email !== email)
                  throw new Error('Canonical verification issuance binding failed');
                await invalidatePrototypeCanonicalVerification(transaction, userId);
                let nonce: string | undefined;
                let identifier: string | undefined;
                for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
                  const candidate = createNonce();
                  if (!/^[a-f0-9]{64}$/.test(candidate))
                    throw new Error('Canonical verification nonce generation failed');
                  const candidateIdentifier = receiptIdentifier(token, candidate);
                  const existing = await transaction
                    .select({ id: schema.verification.id })
                    .from(schema.verification)
                    .where(eq(schema.verification.identifier, candidateIdentifier))
                    .limit(1);
                  if (existing.length === 0) {
                    nonce = candidate;
                    identifier = candidateIdentifier;
                    break;
                  }
                }
                if (!nonce || !identifier) throw new Error('Canonical verification nonce collision limit reached');
                const binding: PrototypeVerificationBinding = {
                  type: 'prototype-canonical-verification',
                  purpose: 'verify-current-email',
                  userId,
                  intendedEmail: email,
                  issuedAtSeconds: claims.issuedAtSeconds,
                  expiresAtSeconds: claims.expiresAtSeconds,
                  consumedAt: null,
                  supersededAt: null,
                };
                const expiresAt = new Date(claims.expiresAtSeconds * 1000);
                const created = await authContext.internalAdapter.createVerificationValue({
                  identifier,
                  value: JSON.stringify(binding),
                  expiresAt,
                });
                if (!created) throw new Error('Canonical verification receipt creation failed');
                const persisted = await transaction
                  .select()
                  .from(schema.verification)
                  .where(eq(schema.verification.identifier, identifier))
                  .limit(2);
                if (
                  persisted.length !== 1 ||
                  persisted[0].value !== JSON.stringify(binding) ||
                  persisted[0].expiresAt.getTime() !== expiresAt.getTime()
                )
                  throw new Error('Canonical verification receipt persistence failed');
                const url = new URL(`${PROTOTYPE_ISSUER}${PROTOTYPE_VERIFICATION_PATHS.verify}`);
                url.search = new URLSearchParams({ token, nonce }).toString();
                outgoing.push({ userId, email, token, nonce, url: url.toString(), expiresAt: new Date(expiresAt) });
              },
            },
            plugins: [plugin, ...(options.authority?.plugins ?? [])],
          });
          const response = await authority.handler(captured);
          if (!response.ok) throw new PrototypeResponseRollback(response);
          return response;
        });
      } catch (error) {
        if (!(error instanceof PrototypeResponseRollback)) throw error;
        const safeHeaders = new Headers(error.response.headers);
        safeHeaders.delete('set-cookie');
        return new Response(error.response.body, { status: error.response.status, headers: safeHeaders });
      }
      if (isSend) {
        const remaining = SEND_MINIMUM_MS - (performance.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      // Fixture delivery happens only after COMMIT. A production deployment
      // needs a durable delivery outbox and retries; this callback sends no mail.
      await Promise.allSettled(outgoing.map((message) => Promise.resolve().then(() => onVerificationIssued(message))));
      return result;
    },
  };
}
