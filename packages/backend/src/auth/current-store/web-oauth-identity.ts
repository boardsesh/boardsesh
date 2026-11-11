import { createHash } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import { authSubjectCutoffs, authWebOAuthCommands, authWebOAuthIntents } from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_COMMAND_TIMEOUT_MS,
  WEB_OAUTH_PROTOCOL_VERSION,
  webOAuthIntentReplySchema,
  webOAuthResolveReplySchema,
  type WebOAuthCommand,
  type WebOAuthIntentCommand,
  type WebOAuthResolveCommand,
  type WebOAuthResolveDenialCode,
  type WebOAuthIntentReply,
  type WebOAuthResolveReply,
} from '@boardsesh/auth-protocol';
import { assertFresh, transactionSettings } from './command-context';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  lockProviderSubject,
  lockSubjectRow,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import { readNegativeWebOAuthActor, webOAuthActorStillValid, type NegativeWebOAuthActor } from './web-oauth-actor';
import { resolveReservedCurrentStoreOAuthIdentity } from './provider-oauth-identity';

export const WEB_OAUTH_INTENT_LIFETIME_MS = 15 * 60_000;
type Unavailable = { readonly outcome: 'unavailable' };
type Intent = typeof authWebOAuthIntents.$inferSelect;

function digest(parts: readonly string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function denied<
  Operation extends 'intent' | 'resolve',
  Code extends WebOAuthResolveDenialCode = 'identity_unavailable',
>(operation: Operation, requestId: string, code: Code = 'identity_unavailable' as Code) {
  return {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation,
    requestId,
    outcome: 'denied',
    code,
  } as const;
}
async function nowMilliseconds(transaction: CurrentStoreTransaction) {
  const row = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(row?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Web OAuth clock unavailable');
  return milliseconds;
}
async function claim(
  transaction: CurrentStoreTransaction,
  command: Pick<WebOAuthCommand, 'issuedAt' | 'operation' | 'requestId'>,
) {
  const issuedAt = Date.parse(command.issuedAt);
  assertFresh(issuedAt);
  const inserted = await transaction
    .insert(authWebOAuthCommands)
    .values({
      commandHash: digest(['web-oauth-command-v1', command.requestId.toLowerCase()]),
      operation: command.operation,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(issuedAt + AUTH_COMMAND_MAX_AGE_MS + AUTH_COMMAND_FUTURE_SKEW_MS + AUTH_COMMAND_TIMEOUT_MS),
    })
    .onConflictDoNothing()
    .returning({ commandHash: authWebOAuthCommands.commandHash });
  return inserted.length === 1;
}
async function captureActor(cookie: string | null, secret: string) {
  try {
    return { actor: await readNegativeWebOAuthActor(cookie, secret), valid: true };
  } catch {
    return { actor: null, valid: false };
  }
}
async function actorGeneration(transaction: CurrentStoreTransaction, actor: NegativeWebOAuthActor | null) {
  if (!actor) return { valid: true, generation: null };
  const user = await lockSubjectRow(transaction, actor.userId);
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, actor.userId))
    .for('update');
  return { valid: Boolean(user) && !cutoff?.deletedAt, generation: cutoff?.generation ?? 0 };
}
function sameBinding(before: Intent, after: Intent) {
  return (
    before.intentHash === after.intentHash &&
    before.provider === after.provider &&
    before.flowHash === after.flowHash &&
    before.actorUserId === after.actorUserId &&
    before.actorLineageHash === after.actorLineageHash &&
    before.actorObservedGeneration === after.actorObservedGeneration &&
    before.issuedAt.getTime() === after.issuedAt.getTime() &&
    before.expiresAt.getTime() === after.expiresAt.getTime()
  );
}

/** Trusted web verifies the provider; backend exclusively resolves and writes identity. */
export async function recordWebOAuthIntent(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  nextAuthSecret: string,
  input: WebOAuthIntentCommand,
): Promise<WebOAuthIntentReply> {
  const authority = captureExpectedAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { provider, flow, actorCookie } = input.payload;
  const captured = await captureActor(actorCookie, nextAuthSecret);
  return database.transaction(async (transaction) => {
    const execute = async (): Promise<WebOAuthIntentReply> => {
      await transactionSettings(transaction);
      await lockEnforcedProjection(transaction, authority);
      if (!(await claim(transaction, { requestId, issuedAt, operation: 'intent' })))
        return denied('intent', requestId, 'replayed');
      assertFresh(Date.parse(issuedAt));
      if (!captured.valid || !webOAuthActorStillValid(captured.actor)) return denied('intent', requestId);
      const actor = await actorGeneration(transaction, captured.actor);
      if (!actor.valid || !webOAuthActorStillValid(captured.actor)) return denied('intent', requestId);
      const now = await nowMilliseconds(transaction);
      const expiresAt = new Date(now + WEB_OAUTH_INTENT_LIFETIME_MS);
      const inserted = await transaction
        .insert(authWebOAuthIntents)
        .values({
          intentHash: digest(['web-oauth-intent-v1', provider, flow]),
          provider,
          flowHash: flow,
          actorUserId: captured.actor?.userId ?? null,
          actorLineageHash: captured.actor?.lineageHash ?? null,
          actorObservedGeneration: actor.generation,
          issuedAt: new Date(now),
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ intentHash: authWebOAuthIntents.intentHash });
      if (inserted.length !== 1) return denied('intent', requestId, 'replayed');
      return webOAuthIntentReplySchema.parse({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'intent',
        requestId,
        outcome: 'recorded',
        flow,
        expiresAt: expiresAt.toISOString(),
      });
    };
    const result = await execute();
    // Every committing result, including denials and nonce conflicts, passes
    // the final deadline fence after all row/uniqueness waits.
    assertFresh(Date.parse(issuedAt));
    if (!webOAuthActorStillValid(captured.actor)) throw new Error('Web OAuth actor expired before commit');
    return result;
  });
}

export async function resolveWebOAuthIdentity(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  nextAuthSecret: string,
  input: WebOAuthResolveCommand,
): Promise<WebOAuthResolveReply | Unavailable> {
  const authority = captureExpectedAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { provider, flow, actorCookie, subject, email, name, image } = input.payload;
  const captured = await captureActor(actorCookie, nextAuthSecret);
  const intentHash = digest(['web-oauth-intent-v1', provider, flow]);
  const [initial] = await database
    .select()
    .from(authWebOAuthIntents)
    .where(eq(authWebOAuthIntents.intentHash, intentHash));
  const before = initial
    ? { ...initial, issuedAt: new Date(initial.issuedAt), expiresAt: new Date(initial.expiresAt) }
    : undefined;
  return database.transaction(async (transaction) => {
    const execute = async (): Promise<WebOAuthResolveReply | Unavailable> => {
      await transactionSettings(transaction);
      await lockEnforcedProjection(transaction, authority);
      if (!(await claim(transaction, { requestId, issuedAt, operation: 'resolve' })))
        return denied('resolve', requestId, 'replayed');
      assertFresh(Date.parse(issuedAt));
      // The provider subject's lock before the actor's users row (section 4's
      // order: gate, subject, users). A native sign-in for the same subject takes
      // the subject first and then its owner's row, so taking the actor's row
      // first here could wait on it in a cycle. Re-entrant when resolved below.
      await lockProviderSubject(transaction, provider, subject);
      const [intent] = await transaction
        .select()
        .from(authWebOAuthIntents)
        .where(eq(authWebOAuthIntents.intentHash, intentHash))
        .for('update');
      if (
        !before ||
        !intent ||
        !sameBinding(before, intent) ||
        intent.provider !== provider ||
        intent.flowHash !== flow ||
        intent.consumedAt ||
        !captured.valid ||
        !webOAuthActorStillValid(captured.actor) ||
        intent.actorUserId !== (captured.actor?.userId ?? null) ||
        intent.actorLineageHash !== (captured.actor?.lineageHash ?? null)
      )
        return denied('resolve', requestId);
      const actor = await actorGeneration(transaction, captured.actor);
      if (
        !actor.valid ||
        actor.generation !== intent.actorObservedGeneration ||
        !webOAuthActorStillValid(captured.actor)
      )
        return denied('resolve', requestId);
      const consumed = await transaction
        .update(authWebOAuthIntents)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(authWebOAuthIntents.intentHash, intentHash),
            isNull(authWebOAuthIntents.consumedAt),
            sql`${authWebOAuthIntents.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ intentHash: authWebOAuthIntents.intentHash });
      if (consumed.length !== 1) return denied('resolve', requestId);
      // PostgreSQL must receive the exact provider subject/address, not a lossy
      // UTF-8 replacement of an unpaired JavaScript surrogate.
      if (
        !subject.trim() ||
        [subject, email, name, image].some(
          (text) => typeof text === 'string' && Buffer.from(text, 'utf8').toString('utf8') !== text,
        )
      )
        return denied('resolve', requestId);
      const identity = await resolveReservedCurrentStoreOAuthIdentity(
        transaction,
        authority,
        provider,
        { sub: subject, email, name, image, emailVerified: false },
        { emailStorage: 'provided', emailVerification: 'unverified', actorUserId: captured.actor?.userId ?? null },
      );
      assertFresh(Date.parse(issuedAt));
      if (
        !webOAuthActorStillValid(captured.actor) ||
        (await nowMilliseconds(transaction)) >= intent.expiresAt.getTime()
      )
        throw new Error('Web OAuth intent expired before completion');
      if (identity.outcome === 'sensitive_link_unavailable') return { outcome: 'unavailable' } as const;
      if (identity.outcome === 'conflict') return denied('resolve', requestId, 'email_conflict');
      if (identity.outcome === 'no_email') return denied('resolve', requestId, 'email_required');
      if (identity.outcome !== 'linked' && identity.outcome !== 'created') return denied('resolve', requestId);
      const user = identity.user;
      return webOAuthResolveReplySchema.parse({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'resolve',
        requestId,
        outcome: 'resolved',
        createdUser: identity.outcome === 'created',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
        },
        account: { provider, providerAccountId: subject },
      });
    };
    const result = await execute();
    // Every committing result, including denials and nonce conflicts, passes
    // the final deadline fence after all row/uniqueness waits.
    assertFresh(Date.parse(issuedAt));
    if (!webOAuthActorStillValid(captured.actor)) throw new Error('Web OAuth actor expired before commit');
    return result;
  });
}
