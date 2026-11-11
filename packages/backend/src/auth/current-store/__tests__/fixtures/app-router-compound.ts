import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  accounts,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  sessions,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { normalizeAccountEmail } from '../../../normalize-email';
import { reserveEnforcedEmail } from '../../email-reservations';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from '../../foundation-context';

// Test-only public NextAuth API; neither production options nor a core handler
// is imported or patched. These receipts are not a legacy-cookie bridge.
const webRequire = createRequire(new URL('../../../../../../web/package.json', import.meta.url));
const jwt = webRequire('next-auth/jwt') as {
  encode(options: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
  decode(options: { secret: string; token: string }): Promise<Record<string, unknown> | null>;
};
/** Fixture-only: stands in for the manifest row lock this authority used to share with every command. */
const COMPOUND_FIXTURE_LOCK_KEY = 0x43504d44; // 'CPMD'
const sourceLifetime = 60 * 60 * 1000;
const intentLifetime = 15 * 60 * 1000;
const purpose = 'synthetic-app-router-source-v1' as const;
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const sourceKey = (sourceHash: string) => `ba03-lineage:app-router:${sourceHash}`;
const intentKey = (flow: string) => `ba03-flow:app-router-intent:${flow}`;
const flowKey = (flow: string) => `ba03-flow:app-router-consumed:${flow}`;
const abortedKey = (flow: string, attemptId: string) => `ba03-flow:app-router-aborted:${flow}:${attemptId}`;
const providerSchema = z.enum(['google', 'apple', 'facebook']);
const flowSchema = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const actorCookieSchema = z.string().min(1).max(16384).nullable();
const attemptIdSchema = z.string().uuid();
const intentCommand = z.object({ provider: providerSchema, flow: flowSchema, actorCookie: actorCookieSchema }).strict();
const compoundCommand = intentCommand
  .extend({
    attemptId: attemptIdSchema,
    subject: z
      .string()
      .min(1)
      .refine((subject) => subject.trim().length > 0 && Buffer.byteLength(subject, 'utf8') <= 1024),
    email: z.string().max(4096).optional(),
    name: z.string().max(2048).optional(),
    image: z.string().max(4096).optional(),
  })
  .strict();
const abortCommand = z.union([
  z.object({ sourceProof: proofSchema }).strict(),
  intentCommand.extend({ attemptId: attemptIdSchema }).strict(),
]);
const validateCommand = z.object({ actorCookie: z.string().min(1).max(16384) }).strict();
const actorSchema = z
  .object({
    userId: z.string().min(1),
    sid: z.string().uuid(),
    sourceHash: flowSchema,
    generation: z.number().int().nonnegative(),
    expires: z.number().int().nonnegative(),
    originalAuthenticatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
type Actor = z.infer<typeof actorSchema>;
const intentBindingSchema = z
  .object({
    kind: z.literal('synthetic-intent-v1'),
    provider: providerSchema,
    flow: flowSchema,
    actor: actorSchema.nullable(),
    actorCookieHash: flowSchema.nullable(),
    issuedAt: z.number().int().nonnegative(),
    expires: z.number().int().nonnegative(),
  })
  .strict();
const intentSchema = intentBindingSchema.extend({ seal: flowSchema }).strict();
type Intent = z.infer<typeof intentSchema>;
const sourceSchema = actorSchema
  .extend({
    kind: z.literal(purpose),
    flow: flowSchema.nullable(),
    attemptId: attemptIdSchema.nullable(),
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();
const signedSourceSchema = sourceSchema.omit({ sourceHash: true });
const flowBindingSchema = z
  .object({
    kind: z.literal('synthetic-terminal-flow-v1'),
    provider: providerSchema,
    flow: flowSchema,
    intentHash: flowSchema,
    attemptId: attemptIdSchema,
    issuance: z
      .object({ sourceHash: flowSchema, userId: z.string().min(1), sid: z.string().uuid() })
      .strict()
      .nullable(),
  })
  .strict();
const flowReceiptSchema = flowBindingSchema.extend({ seal: flowSchema }).strict();
const abortedBindingSchema = z
  .object({
    kind: z.literal('synthetic-aborted-attempt-v1'),
    provider: providerSchema,
    flow: flowSchema,
    attemptId: attemptIdSchema,
    intentHash: flowSchema,
  })
  .strict();
const abortedReceiptSchema = abortedBindingSchema.extend({ seal: flowSchema }).strict();

class Rejected extends Error {
  constructor(readonly status: number) {
    super('Synthetic compound admission denied');
  }
}
async function clock(transaction: CurrentStoreTransaction) {
  const instant = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS milliseconds`,
  );
  const milliseconds = Number(instant?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Rejected(503);
  return milliseconds;
}
async function bounded<T>(pending: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic compound deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => request.destroy(), 2000);
  try {
    for await (const chunk of request as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) throw new Rejected(400);
      bytes += chunk.length;
      if (bytes > 32768) throw new Rejected(400);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
function equal(first: string, second: string) {
  const actual = Buffer.from(first);
  const expected = Buffer.from(second);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

/** Unmounted synthetic proof service. Caller owns the restricted local pool. */
export async function startAppRouterCompound(options: {
  database: DbInstance;
  authority: ExpectedCurrentStoreAuthority;
  nextAuthSecret: string;
}) {
  const database = options.database;
  const authority = captureExpectedAuthority(options.authority);
  const nextAuthSecret = options.nextAuthSecret;
  if (Buffer.byteLength(nextAuthSecret, 'utf8') < 32) throw new Error('Invalid synthetic signing key');
  const secret = randomBytes(32).toString('base64url');
  // Fixture-only purpose separation; deterministic across the fixture's own
  // instances, never a production signing/bridge configuration.
  const sourceSigningKey = createHash('sha256').update(`${purpose}\0`).update(nextAuthSecret).digest();
  const mac = (domain: string, binding: object) =>
    createHmac('sha256', sourceSigningKey)
      .update(`${domain}\0${JSON.stringify(binding)}`)
      .digest('hex');
  const sealed = <T extends object>(domain: string, binding: T) => ({ ...binding, seal: mac(domain, binding) });
  const facts = {
    intents: 0,
    compoundCalls: 0,
    createdUsers: 0,
    sources: 0,
    aborts: 0,
    databaseFailure: null as { code: string; constraint: string | null } | null,
  };
  const write = <T>(operation: (transaction: CurrentStoreTransaction) => Promise<T>) =>
    database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
      await lockEnforcedProjection(transaction, authority);
      // This synthetic authority was written against the one-row manifest lock
      // that serialized every staged command. The gate is shared now (BA-04 PR 3)
      // and production commands lock per key and per climber; the fixture keeps
      // its original whole-authority serialization with a lock of its own.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(${COMPOUND_FIXTURE_LOCK_KEY})`);
      return operation(transaction);
    });
  async function record(transaction: CurrentStoreTransaction, identifier: string) {
    const rows = await transaction
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.identifier, identifier));
    if (rows.length > 1) throw new Rejected(503);
    return rows[0];
  }
  function storedReceipt<T>(schema: z.ZodType<T>, text: string): T {
    try {
      const parsed = schema.safeParse(JSON.parse(text) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      /* A corrupt stored receipt is authority uncertainty. */
    }
    throw new Rejected(503);
  }
  async function signedBinding(proof: string, current: boolean) {
    try {
      const verified = await jwtVerify(proof, sourceSigningKey, {
        algorithms: ['HS256'],
        issuer: purpose,
        audience: purpose,
        requiredClaims: ['sub', 'exp'],
        ...(!current ? { currentDate: new Date(0) } : {}),
      });
      const { iss: _issuer, aud: _audience, sub, iat: _issued, exp: _expiry, ...binding } = verified.payload;
      const parsed = signedSourceSchema.parse(binding);
      if (sub !== parsed.userId) throw new Rejected(403);
      return sourceSchema.parse({ ...parsed, sourceHash: digest(proof) });
    } catch {
      throw new Rejected(403);
    }
  }
  async function sourceFor(transaction: CurrentStoreTransaction, cookie: string, current: boolean): Promise<Actor> {
    let claims: Record<string, unknown> | null;
    try {
      claims = await jwt.decode({ secret: nextAuthSecret, token: cookie });
    } catch {
      throw new Rejected(403);
    }
    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      typeof claims.authSessionId !== 'string' ||
      !proofSchema.safeParse(claims.sourceProof).success
    )
      throw new Rejected(403);
    const sourceHash = digest(claims.sourceProof as string);
    const signed = await signedBinding(claims.sourceProof as string, current);
    const stored = await record(transaction, sourceKey(sourceHash));
    const source = stored ? storedReceipt(sourceSchema, stored.token) : undefined;
    if (
      !source ||
      JSON.stringify(source) !== JSON.stringify(signed) ||
      source.sourceHash !== sourceHash ||
      source.userId !== claims.sub ||
      source.sid !== claims.authSessionId ||
      stored!.expires.getTime() !== source.expires
    )
      throw new Rejected(403);
    const binding = source;
    if (
      binding.expires <= binding.issuedAt ||
      binding.expires - binding.issuedAt !== sourceLifetime ||
      (binding.originalAuthenticatedAt !== null && binding.originalAuthenticatedAt > binding.issuedAt)
    )
      throw new Rejected(403);
    if (current) {
      const [user] = await transaction.select().from(users).where(eq(users.id, binding.userId)).for('update');
      const [cutoff] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, binding.userId))
        .for('update');
      const [session] = await transaction
        .select()
        .from(sessions)
        .where(eq(sessions.sessionToken, sourceKey(sourceHash)))
        .for('update');
      const now = await clock(transaction);
      if (
        !user ||
        !session ||
        session.userId !== binding.userId ||
        session.expires.getTime() !== binding.expires ||
        cutoff?.deletedAt ||
        (cutoff?.generation ?? 0) !== binding.generation ||
        binding.expires <= now
      )
        throw new Rejected(403);
    }
    return {
      userId: binding.userId,
      sid: binding.sid,
      sourceHash: binding.sourceHash,
      generation: binding.generation,
      expires: binding.expires,
      originalAuthenticatedAt: binding.originalAuthenticatedAt,
    };
  }
  async function boundActor(
    transaction: CurrentStoreTransaction,
    intent: Intent,
    cookie: string | null,
    current: boolean,
  ) {
    if (!current) {
      // Negative authority only: the sealed intent authenticated this exact
      // cookie when current. Its hash may target only this flow's issuance;
      // expiry/revocation never makes it a current actor or a new credential.
      if (cookie === null) {
        if (intent.actor !== null || intent.actorCookieHash !== null) throw new Rejected(403);
        return null;
      }
      if (!intent.actor || !intent.actorCookieHash || !equal(digest(cookie), intent.actorCookieHash))
        throw new Rejected(403);
      return intent.actor;
    }
    const actor = cookie === null ? null : await sourceFor(transaction, cookie, current);
    if (JSON.stringify(actor) !== JSON.stringify(intent.actor)) throw new Rejected(403);
    return actor;
  }
  async function loadIntent(
    transaction: CurrentStoreTransaction,
    provider: z.infer<typeof providerSchema>,
    flow: string,
  ) {
    const row = await record(transaction, intentKey(flow));
    if (!row && (await record(transaction, flowKey(flow)))) throw new Rejected(503);
    const parsed = row ? storedReceipt(intentSchema, row.token) : undefined;
    if (parsed) {
      const { seal, ...binding } = parsed;
      if (!equal(seal, mac('intent', binding))) throw new Rejected(503);
    }
    if (
      !parsed ||
      parsed.provider !== provider ||
      parsed.flow !== flow ||
      row!.expires.getTime() !== parsed.expires + sourceLifetime ||
      parsed.expires <= parsed.issuedAt ||
      parsed.expires - parsed.issuedAt > intentLifetime
    )
      throw new Rejected(403);
    return { intent: parsed, hash: digest(row!.token) };
  }
  async function linkedMembership(transaction: CurrentStoreTransaction, userId: string, email: string) {
    const key = normalizeAccountEmail(email);
    const [reservation] = await transaction
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, key))
      .for('update');
    const members = await transaction
      .select()
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, key))
      .for('update');
    if (
      !reservation ||
      reservation.basisProjectionId !== authority.expectedProjectionId ||
      !members.some((member) => member.userId === userId)
    )
      throw new Rejected(503);
    if (reservation.state === 'blocked_ambiguous') return;
    if (reservation.state !== 'owned' || reservation.ownerUserId !== userId || members.length !== 1)
      throw new Rejected(503);
  }
  async function createSource(
    transaction: CurrentStoreTransaction,
    userId: string,
    originalAuthenticatedAt: number | null,
    flow: string | null,
    attemptId: string | null = null,
  ) {
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).for('update');
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId))
      .for('update');
    const issuedAt = await clock(transaction);
    if (
      !user ||
      cutoff?.deletedAt ||
      (originalAuthenticatedAt !== null &&
        (!Number.isSafeInteger(originalAuthenticatedAt) ||
          originalAuthenticatedAt < 0 ||
          originalAuthenticatedAt > issuedAt))
    )
      throw new Rejected(403);
    const sourceSid = randomUUID();
    const signed = {
      kind: purpose,
      userId,
      sid: sourceSid,
      generation: cutoff?.generation ?? 0,
      expires: issuedAt + sourceLifetime,
      originalAuthenticatedAt,
      flow,
      attemptId,
      issuedAt,
    };
    const sourceProof = await new SignJWT(signed)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(purpose)
      .setAudience(purpose)
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .setExpirationTime(Math.ceil(signed.expires / 1000))
      .sign(sourceSigningKey);
    const source = sourceSchema.parse({ ...signed, sourceHash: digest(sourceProof) });
    await transaction
      .insert(sessions)
      .values({ sessionToken: sourceKey(source.sourceHash), userId, expires: new Date(source.expires) });
    await transaction.insert(verificationTokens).values({
      identifier: sourceKey(source.sourceHash),
      token: JSON.stringify(source),
      expires: new Date(source.expires),
    });
    return {
      sourceProof,
      sourceSid,
      generation: source.generation,
      originalAuthenticatedAt,
      sourceHash: source.sourceHash,
    };
  }
  async function abortProof(transaction: CurrentStoreTransaction, proof: string) {
    const stored = await record(transaction, sourceKey(digest(proof)));
    if (!stored) return;
    const parsed = storedReceipt(sourceSchema, stored.token);
    if (JSON.stringify(parsed) !== JSON.stringify(await signedBinding(proof, false))) throw new Rejected(403);
    await transaction
      .delete(sessions)
      .where(and(eq(sessions.sessionToken, sourceKey(parsed.sourceHash)), eq(sessions.userId, parsed.userId)));
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!equal(request.headers.authorization ?? '', `Bearer ${secret}`) || request.headers.origin !== undefined)
      return json(response, 401, { error: 'denied' });
    if (
      request.method !== 'POST' ||
      request.headers['content-type']?.split(';')[0].trim() !== 'application/json' ||
      !['/intent', '/compound', '/abort', '/validate'].includes(request.url ?? '')
    )
      return json(response, 400, { error: 'denied' });
    const input = await readBody(request);
    if (request.url === '/intent') {
      const command = intentCommand.parse(input);
      await write(async (transaction) => {
        if ((await record(transaction, intentKey(command.flow))) || (await record(transaction, flowKey(command.flow))))
          throw new Rejected(409);
        const actor = command.actorCookie === null ? null : await sourceFor(transaction, command.actorCookie, true);
        const issuedAt = await clock(transaction);
        const expires = Math.min(issuedAt + intentLifetime, actor?.expires ?? Infinity);
        if (expires <= issuedAt) throw new Rejected(403);
        const binding = {
          kind: 'synthetic-intent-v1',
          provider: command.provider,
          flow: command.flow,
          actor,
          actorCookieHash: command.actorCookie === null ? null : digest(command.actorCookie),
          issuedAt,
          expires,
        } as const;
        const intent: Intent = sealed('intent', binding);
        await transaction.insert(verificationTokens).values({
          identifier: intentKey(command.flow),
          token: JSON.stringify(intent),
          expires: new Date(expires + sourceLifetime),
        });
      });
      facts.intents += 1;
      return json(response, 200, {});
    }
    if (request.url === '/validate') {
      const command = validateCommand.parse(input);
      const actor = await write((transaction) => sourceFor(transaction, command.actorCookie, true));
      return json(response, 200, {
        valid: true,
        userId: actor.userId,
        sourceSid: actor.sid,
        generation: actor.generation,
        originalAuthenticatedAt: actor.originalAuthenticatedAt,
      });
    }
    if (request.url === '/abort') {
      const command = abortCommand.parse(input);
      await write(async (transaction) => {
        if ('sourceProof' in command) return abortProof(transaction, command.sourceProof);
        const { intent, hash } = await loadIntent(transaction, command.provider, command.flow);
        await boundActor(transaction, intent, command.actorCookie, false);
        const terminal = await record(transaction, flowKey(command.flow));
        if (terminal) {
          const receipt = storedReceipt(flowReceiptSchema, terminal.token);
          const { seal, ...binding } = receipt;
          if (!equal(seal, mac('flow', binding))) throw new Rejected(503);
          if (receipt.provider !== command.provider || receipt.flow !== command.flow || receipt.intentHash !== hash)
            throw new Rejected(403);
          // A losing callback's unknown reply cannot cancel the winning
          // sibling, even though both share the verified flow and actor.
          if (receipt.attemptId !== command.attemptId) return;
          if (receipt.issuance) {
            const lineage = await record(transaction, sourceKey(receipt.issuance.sourceHash));
            const source = lineage ? storedReceipt(sourceSchema, lineage.token) : undefined;
            if (
              !source ||
              source.userId !== receipt.issuance.userId ||
              source.sid !== receipt.issuance.sid ||
              source.flow !== command.flow ||
              source.attemptId !== command.attemptId
            )
              throw new Rejected(503);
            await transaction
              .delete(sessions)
              .where(
                and(
                  eq(sessions.sessionToken, sourceKey(receipt.issuance.sourceHash)),
                  eq(sessions.userId, receipt.issuance.userId),
                ),
              );
          }
        } else {
          if (intent.expires <= (await clock(transaction))) throw new Rejected(403);
          const previous = await record(transaction, abortedKey(command.flow, command.attemptId));
          if (previous) {
            const stored = storedReceipt(abortedReceiptSchema, previous.token);
            const { seal, ...binding } = stored;
            if (
              !equal(seal, mac('aborted-attempt', binding)) ||
              stored.provider !== command.provider ||
              stored.flow !== command.flow ||
              stored.attemptId !== command.attemptId ||
              stored.intentHash !== hash
            )
              throw new Rejected(503);
            return;
          }
          await transaction.insert(verificationTokens).values({
            identifier: abortedKey(command.flow, command.attemptId),
            token: JSON.stringify(
              sealed('aborted-attempt', {
                kind: 'synthetic-aborted-attempt-v1',
                provider: command.provider,
                flow: command.flow,
                attemptId: command.attemptId,
                intentHash: hash,
              }),
            ),
            expires: new Date(intent.expires + sourceLifetime),
          });
        }
      });
      facts.aborts += 1;
      return json(response, 200, {});
    }
    const command = compoundCommand.parse(input);
    facts.compoundCalls += 1;
    const result = await write(async (transaction) => {
      const { intent, hash } = await loadIntent(transaction, command.provider, command.flow);
      if (await record(transaction, flowKey(command.flow))) throw new Rejected(409);
      const aborted = await record(transaction, abortedKey(command.flow, command.attemptId));
      if (aborted) {
        const stored = storedReceipt(abortedReceiptSchema, aborted.token);
        const { seal, ...binding } = stored;
        if (
          !equal(seal, mac('aborted-attempt', binding)) ||
          stored.provider !== command.provider ||
          stored.flow !== command.flow ||
          stored.attemptId !== command.attemptId ||
          stored.intentHash !== hash
        )
          throw new Rejected(503);
        throw new Rejected(409);
      }
      const actor = await boundActor(transaction, intent, command.actorCookie, true);
      if (intent.expires <= (await clock(transaction))) throw new Rejected(403);
      const [link] = await transaction
        .select()
        .from(accounts)
        .where(and(eq(accounts.provider, command.provider), eq(accounts.providerAccountId, command.subject)))
        .for('update');
      let user: typeof users.$inferSelect;
      let createdUser = false;
      if (link) {
        const [stored] = await transaction.select().from(users).where(eq(users.id, link.userId)).for('update');
        if (!stored) throw new Rejected(503);
        if (actor && actor.userId !== stored.id) throw new Rejected(403);
        await linkedMembership(transaction, stored.id, stored.email);
        user = stored;
      } else {
        if (actor || !command.email || !z.email().safeParse(command.email).success) throw new Rejected(403);
        const key = normalizeAccountEmail(command.email);
        const [occupied] = await transaction
          .select()
          .from(authEmailReservations)
          .where(eq(authEmailReservations.normalizedEmail, key))
          .for('update');
        if (occupied) {
          if (occupied.basisProjectionId !== authority.expectedProjectionId) throw new Rejected(503);
          throw new Rejected(409);
        }
        const userId = randomUUID();
        await reserveEnforcedEmail(transaction, { ...authority, rawEmail: command.email, requestedUserId: userId });
        const [inserted] = await transaction
          .insert(users)
          .values({
            id: userId,
            email: command.email,
            name: command.name ?? null,
            image: command.image ?? null,
            emailVerified: null,
          })
          .returning();
        if (!inserted) throw new Rejected(503);
        user = inserted;
        await transaction.insert(userProfiles).values({ userId, displayName: user.name, avatarUrl: user.image });
        await transaction
          .insert(accounts)
          .values({ userId, provider: command.provider, providerAccountId: command.subject, type: 'oauth' });
        createdUser = true;
      }
      const source = await createSource(
        transaction,
        user.id,
        actor?.originalAuthenticatedAt ?? null,
        command.flow,
        command.attemptId,
      );
      if (intent.expires <= (await clock(transaction))) throw new Rejected(403);
      await transaction.insert(verificationTokens).values({
        identifier: flowKey(command.flow),
        token: JSON.stringify(
          sealed('flow', {
            kind: 'synthetic-terminal-flow-v1',
            provider: command.provider,
            flow: command.flow,
            intentHash: hash,
            attemptId: command.attemptId,
            issuance: { sourceHash: source.sourceHash, userId: user.id, sid: source.sourceSid },
          }),
        ),
        expires: new Date(intent.expires + sourceLifetime),
      });
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
        },
        createdUser,
        sourceProof: source.sourceProof,
        sourceSid: source.sourceSid,
        generation: source.generation,
        flow: command.flow,
        attemptId: command.attemptId,
        originalAuthenticatedAt: source.originalAuthenticatedAt,
      };
    });
    facts.sources += 1;
    if (result.createdUser) facts.createdUsers += 1;
    return json(response, 200, result);
  }
  let accepting = true;
  const active = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    const pending = handle(request, response).catch((error: unknown) => {
      let failure = error;
      for (let depth = 0; depth < 5 && failure && typeof failure === 'object'; depth += 1) {
        const candidate = failure as { code?: unknown; constraint_name?: unknown; cause?: unknown };
        if (typeof candidate.code === 'string' && /^[A-Z0-9]{5}$/.test(candidate.code)) {
          facts.databaseFailure = {
            code: candidate.code,
            constraint:
              typeof candidate.constraint_name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(candidate.constraint_name)
                ? candidate.constraint_name
                : null,
          };
          break;
        }
        failure = candidate.cause;
      }
      if (!response.destroyed && !response.headersSent)
        json(
          response,
          error instanceof Rejected
            ? error.status
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 503,
          { error: 'denied' },
        );
      else response.destroy();
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  server.requestTimeout = 9000;
  server.headersTimeout = 9000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    accepting = false;
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic listener unavailable');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    secret,
    facts,
    async issueSource(userId: string, originalAuthenticatedAt: number | null = null) {
      const capturedId = userId;
      const capturedAge = originalAuthenticatedAt;
      const source = await write(async (transaction) => {
        const minted = await createSource(transaction, capturedId, capturedAge, null);
        const cookie = await jwt.encode({
          secret: nextAuthSecret,
          token: { sub: capturedId, authSessionId: minted.sourceSid, sourceProof: minted.sourceProof },
          maxAge: sourceLifetime / 1000,
        });
        return { ...minted, cookie };
      });
      return { cookie: source.cookie, sourceProof: source.sourceProof, sourceSid: source.sourceSid };
    },
    async revokeSource(sourceProof: string) {
      const captured = proofSchema.parse(sourceProof);
      await write((transaction) => abortProof(transaction, captured));
    },
    async close() {
      accepting = false;
      const failures: Error[] = [];
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections();
          }),
          3000,
        );
      } catch {
        for (const socket of sockets) socket.destroy();
        failures.push(new Error('Synthetic listener cleanup failed'));
      }
      try {
        await bounded(Promise.allSettled(active));
      } catch {
        failures.push(new Error('Synthetic handler cleanup failed'));
      }
      if (active.size || server.listening) failures.push(new Error('Synthetic service remains active'));
      if (failures.length) throw new AggregateError(failures, 'Synthetic compound cleanup failed');
    },
  };
}
