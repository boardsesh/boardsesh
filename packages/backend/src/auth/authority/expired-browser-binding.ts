import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authBrowserBindings, users, verificationTokens } from '@boardsesh/db/schema/auth';
import {
  EXPIRED_BROWSER_BINDING_PREPARATION_MS,
  EXPIRED_BROWSER_BINDING_ACK_MS,
  EXPIRED_BROWSER_BINDING_TARGET_MS,
  expiredBrowserBindingCommandSchema,
  expiredBrowserBindingPreparationSchema,
  type ExpiredBrowserBindingCommand,
  type ExpiredBrowserBindingPreparation,
  type ExpiredBrowserBindingReply,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from './router';
import { providerDatabaseNow } from './provider-security-context';
import { isWebPasswordCommandFresh, transactionSettings } from '../current-store/command-context';

/** Deliberately outside email/reset identifiers, ba03-web-auth: command claims,
 * and ba03-native-handoff-v1: capabilities and maintenance. */
export const EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX = 'ba03-expired-browser-binding-v1:';
export const EXPIRED_BROWSER_BINDING_PUBLIC_READY = false;
type Binding = typeof authBrowserBindings.$inferSelect;
type Failure = 'denied' | 'conflict' | 'unavailable';
class RetirementRefusal extends Error {
  constructor(readonly outcome: Failure) {
    super('Expired browser binding command refused');
  }
}
function refuse(outcome: Failure): never {
  throw new RetirementRefusal(outcome);
}
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const token = () => randomBytes(32).toString('base64url');
function receiptHash(operationToken: string, preparation: ExpiredBrowserBindingPreparation, completed: boolean) {
  return digest(
    JSON.stringify([
      'expired-browser-binding-receipt-v1',
      completed ? 'completed' : 'prepared',
      digest(operationToken),
      preparation,
    ]),
  );
}
function sameAuthority(preparation: ExpiredBrowserBindingPreparation, authority: IdentityAuthorityReceipt) {
  return (
    preparation.authority.projectionId === authority.projectionId &&
    preparation.authority.normalizerVersion === authority.normalizerVersion &&
    preparation.authority.authority === authority.authority &&
    preparation.authority.epoch === authority.epoch
  );
}
/** The expired selection is never admitted as a principal. Its observed user
 * lock only preserves the existing gate -> user -> binding ordering. A deleted
 * user does not turn the expired row into proof or a live anonymous selection. */
async function lockOldBinding(transaction: AuthorityTransaction, bindingId: string) {
  const [observed] = await transaction.select().from(authBrowserBindings).where(eq(authBrowserBindings.id, bindingId));
  if (!observed) return refuse('denied');
  if (observed.userId)
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, observed.userId)).for('update');
  const [locked] = await transaction
    .select()
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, bindingId))
    .for('update');
  if (!locked || observed.userId !== locked.userId) return refuse('conflict');
  // PostgreSQL's complete row representation retains timestamp microseconds;
  // converting through JavaScript Date would lose part of the exact old state.
  const [precise] = await transaction
    .select({
      state: sql<string>`to_jsonb(${authBrowserBindings})::text`,
      expired: sql<boolean>`${authBrowserBindings.expiresAt} <= clock_timestamp()`,
    })
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, bindingId));
  if (!precise) return refuse('conflict');
  return {
    binding: locked,
    expired: precise.expired,
    stateHash: digest(JSON.stringify(['expired-browser-binding-full-row-v1', precise.state])),
  };
}
function assertClock(preparation: ExpiredBrowserBindingPreparation, now: Date, completed: boolean) {
  const clock = now.getTime();
  if (
    clock < Date.parse(preparation.preparedAt) ||
    clock >= Date.parse(completed ? preparation.acknowledgeUntil : preparation.expiresAt) ||
    clock >= Date.parse(preparation.targetCursor.bindingExpiresAt) ||
    Date.parse(preparation.oldExpiresAt) > clock
  )
    refuse('conflict');
}
function assertOld(binding: Binding, stateHash: string, preparation: ExpiredBrowserBindingPreparation) {
  if (
    binding.id !== preparation.oldBindingId ||
    binding.version !== preparation.oldVersion ||
    binding.intentRevision !== preparation.oldIntentRevision ||
    stateHash !== preparation.oldStateHash
  )
    refuse('conflict');
}
function isExactAnonymousTarget(binding: Binding, preparation: ExpiredBrowserBindingPreparation) {
  return (
    binding.id === preparation.targetCursor.bindingId &&
    binding.version === 0 &&
    binding.intentRevision === 0 &&
    binding.userId === null &&
    binding.credentialKind === null &&
    binding.authSessionId === null &&
    binding.generation === null &&
    binding.authenticatedAt === null &&
    binding.credentialExpiresAt === null &&
    !binding.requiresAccountCutoff &&
    !binding.linkGuarded &&
    binding.createdAt.getTime() === Date.parse(preparation.preparedAt) &&
    binding.expiresAt.getTime() === Date.parse(preparation.targetCursor.bindingExpiresAt)
  );
}

/** A distinct explicit-action protocol: no generic reader/logout fallback,
 * source issuer, credential revocation or admission of an expired actor. */
export async function executeExpiredBrowserBindingCommand(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  input: ExpiredBrowserBindingCommand,
): Promise<ExpiredBrowserBindingReply> {
  const requested = Object.freeze({ ...qualification });
  const command = expiredBrowserBindingCommandSchema.parse(input);
  const metadata = {
    expiredBrowserBindingProtocolVersion: 1 as const,
    requestId: command.requestId,
    operation: command.operation,
  };
  if (!isWebPasswordCommandFresh(command.issuedAt)) return { ...metadata, outcome: 'denied' };
  try {
    return await database.transaction(async (transaction): Promise<ExpiredBrowserBindingReply> => {
      await transactionSettings(transaction);
      await transaction.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
      const authority = await captureIdentityAuthority(transaction, requested);
      const oldState = await lockOldBinding(transaction, digest(command.payload.bindingToken));
      const old = oldState.binding;
      const now = await providerDatabaseNow(transaction);
      if (!oldState.expired || old.expiresAt.getTime() > now.getTime()) return refuse('denied');
      if (command.operation === 'prepare') {
        if (command.payload.expectedVersion !== undefined && old.version !== command.payload.expectedVersion)
          return refuse('conflict');
        const operationToken = token();
        const targetBindingToken = token();
        const preparation = expiredBrowserBindingPreparationSchema.parse({
          version: 1,
          purpose: 'expired-browser-binding-retirement-v1',
          oldBindingId: old.id,
          oldVersion: old.version,
          oldIntentRevision: old.intentRevision,
          oldStateHash: oldState.stateHash,
          oldExpiresAt: old.expiresAt.toISOString(),
          targetCursor: {
            bindingId: digest(targetBindingToken),
            version: 0,
            bindingExpiresAt: new Date(now.getTime() + EXPIRED_BROWSER_BINDING_TARGET_MS).toISOString(),
          },
          nonceHash: command.payload.nonceHash,
          authority,
          preparedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + EXPIRED_BROWSER_BINDING_PREPARATION_MS).toISOString(),
          acknowledgeUntil: new Date(now.getTime() + EXPIRED_BROWSER_BINDING_ACK_MS).toISOString(),
        });
        await transaction.insert(verificationTokens).values({
          identifier: `${EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX}${digest(operationToken)}`,
          token: receiptHash(operationToken, preparation, false),
          expires: new Date(preparation.acknowledgeUntil),
        });
        await revalidateIdentityAuthority(transaction, authority);
        assertClock(preparation, await providerDatabaseNow(transaction), false);
        return {
          ...metadata,
          operation: 'prepare',
          outcome: 'prepared',
          operationToken,
          targetBindingToken,
          preparation,
        };
      }
      const { preparation, operationToken, targetBindingToken } = command.payload;
      if (!sameAuthority(preparation, authority)) return refuse('conflict');
      if (digest(targetBindingToken) !== preparation.targetCursor.bindingId) return refuse('denied');
      assertOld(old, oldState.stateHash, preparation);
      const identifier = `${EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX}${digest(operationToken)}`;
      const receipts = await transaction
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, identifier))
        .limit(2)
        .for('update');
      if (receipts.length !== 1 || receipts[0].expires.getTime() !== Date.parse(preparation.acknowledgeUntil))
        return refuse('denied');
      const preparedHash = receiptHash(operationToken, preparation, false);
      const completedHash = receiptHash(operationToken, preparation, true);
      if (command.operation === 'acknowledge') {
        if (receipts[0].token !== completedHash) return refuse('conflict');
        assertClock(preparation, now, true);
        const [target] = await transaction
          .select()
          .from(authBrowserBindings)
          .where(
            and(
              eq(authBrowserBindings.id, preparation.targetCursor.bindingId),
              eq(authBrowserBindings.createdAt, new Date(preparation.preparedAt)),
              eq(authBrowserBindings.expiresAt, new Date(preparation.targetCursor.bindingExpiresAt)),
            ),
          )
          .for('update');
        if (!target || !isExactAnonymousTarget(target, preparation)) return refuse('conflict');
        await revalidateIdentityAuthority(transaction, authority);
        assertClock(preparation, await providerDatabaseNow(transaction), true);
        return { ...metadata, operation: 'acknowledge', outcome: 'completed', cursor: preparation.targetCursor };
      }
      // Finalize deliberately refuses completed state. Unknown replies recover
      // through the separate read-only ACK, never a repeated mutation.
      if (receipts[0].token !== preparedHash) return refuse('conflict');
      assertClock(preparation, now, false);
      const inserted = await transaction
        .insert(authBrowserBindings)
        .values({
          id: preparation.targetCursor.bindingId,
          version: 0,
          intentRevision: 0,
          createdAt: new Date(preparation.preparedAt),
          expiresAt: new Date(preparation.targetCursor.bindingExpiresAt),
        })
        .onConflictDoNothing()
        .returning({ id: authBrowserBindings.id });
      if (inserted.length !== 1) return refuse('conflict');
      const completed = await transaction
        .update(verificationTokens)
        .set({ token: completedHash })
        .where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, preparedHash)))
        .returning({ token: verificationTokens.token });
      if (completed.length !== 1) return refuse('conflict');
      await revalidateIdentityAuthority(transaction, authority);
      // Must throw inside this transaction if a late write loses the deadline.
      assertClock(preparation, await providerDatabaseNow(transaction), false);
      return { ...metadata, operation: 'finalize', outcome: 'completed', cursor: preparation.targetCursor };
    });
  } catch (error) {
    return { ...metadata, outcome: error instanceof RetirementRefusal ? error.outcome : 'unavailable' };
  }
}
