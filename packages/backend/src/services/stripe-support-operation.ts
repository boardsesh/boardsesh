import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { stripeSupportOperations, type SupportDeletionIntent } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { lockSupportAccount, type SupportTransaction } from './stripe-support-lock';

export type { SupportTransaction } from './stripe-support-lock';
export type { SupportDeletionIntent } from '@boardsesh/db/schema';
export type SupportOperationKind = 'checking_checkout' | 'accepting' | 'subscription' | 'deleting' | 'reconciling';
export const SUPPORT_OPERATION_LEASE_MS = 5 * 60 * 1000;

function pendingOperationError() {
  return new GraphQLError('Another billing operation is in progress. Try again shortly.', {
    extensions: { code: 'SUPPORT_OPERATION_PENDING' },
  });
}

function staleOperationError() {
  return new GraphQLError('Support operation expired. Retry to reconcile billing.', {
    extensions: { code: 'SUPPORT_OPERATION_STALE' },
  });
}

/**
 * Stripe I/O runs only in perform, outside transactions. prepare and finish
 * perform database work only. Missing accounts return null before any effects.
 * Deletion intent survives crashes/errors and only deletion can resume it.
 */
export async function withSupportOperation<Prepared, Network, Result>(
  userId: string,
  kind: SupportOperationKind,
  prepare: (transaction: SupportTransaction, priorDeletionIntent: SupportDeletionIntent | null) => Promise<Prepared>,
  perform: (prepared: Prepared, operationId: string) => Promise<Network>,
  finish: (transaction: SupportTransaction, prepared: Prepared, networkResult: Network) => Promise<Result>,
  options?: { deletionIntent: (prepared: Prepared) => SupportDeletionIntent },
): Promise<Result | null> {
  const ownerToken = randomUUID();
  const reservation = await db.transaction(async (transaction) => {
    if (!(await lockSupportAccount(transaction, userId))) return null;
    const [previousOperation] = await transaction
      .select()
      .from(stripeSupportOperations)
      .where(eq(stripeSupportOperations.userId, userId))
      .limit(1);
    const now = new Date();
    const resumingDeletion = previousOperation?.state === 'deleting';
    if (resumingDeletion && kind !== 'deleting') throw pendingOperationError();
    if (
      previousOperation &&
      previousOperation.state !== 'idle' &&
      previousOperation.leaseExpiresAt &&
      previousOperation.leaseExpiresAt > now
    ) {
      throw pendingOperationError();
    }
    if (resumingDeletion && (!previousOperation.operationId || !previousOperation.deletionIntent)) {
      throw new GraphQLError('Stored deletion intent requires reconciliation.', {
        extensions: { code: 'SUPPORT_OPERATION_PENDING' },
      });
    }
    const prepared = await prepare(transaction, resumingDeletion ? previousOperation.deletionIntent : null);
    const operationId = resumingDeletion ? previousOperation.operationId! : randomUUID();
    const deletionIntent = resumingDeletion
      ? previousOperation.deletionIntent
      : (options?.deletionIntent(prepared) ?? null);
    if (kind === 'deleting' && !deletionIntent) throw new Error('Deleting support operations require a durable intent');
    const operation = {
      userId,
      state: kind,
      operationId,
      ownerToken,
      leaseExpiresAt: new Date(now.getTime() + SUPPORT_OPERATION_LEASE_MS),
      deletionIntent: kind === 'deleting' ? deletionIntent : null,
    };
    await transaction
      .insert(stripeSupportOperations)
      .values(operation)
      .onConflictDoUpdate({ target: stripeSupportOperations.userId, set: operation });
    return { prepared, operationId };
  });
  if (!reservation) return null;

  try {
    const networkResult = await perform(reservation.prepared, reservation.operationId);
    return await db.transaction(async (transaction) => {
      if (!(await lockSupportAccount(transaction, userId))) throw staleOperationError();
      const [operation] = await transaction
        .select()
        .from(stripeSupportOperations)
        .where(eq(stripeSupportOperations.userId, userId))
        .limit(1);
      if (
        !operation ||
        operation.ownerToken !== ownerToken ||
        operation.operationId !== reservation.operationId ||
        operation.state !== kind ||
        (kind !== 'deleting' && (!operation.leaseExpiresAt || operation.leaseExpiresAt.getTime() <= Date.now()))
      ) {
        throw staleOperationError();
      }
      const result = await finish(transaction, reservation.prepared, networkResult);
      await transaction
        .update(stripeSupportOperations)
        .set({ state: 'idle', operationId: null, ownerToken: null, leaseExpiresAt: null, deletionIntent: null })
        .where(and(eq(stripeSupportOperations.userId, userId), eq(stripeSupportOperations.ownerToken, ownerToken)));
      return result;
    });
  } catch (error) {
    try {
      // Uncertain deletion retains its durable intent and stable Stripe key.
      await db
        .update(stripeSupportOperations)
        .set(
          kind === 'deleting'
            ? { leaseExpiresAt: new Date() }
            : { state: 'idle', operationId: null, ownerToken: null, leaseExpiresAt: null, deletionIntent: null },
        )
        .where(and(eq(stripeSupportOperations.userId, userId), eq(stripeSupportOperations.ownerToken, ownerToken)));
    } catch (releaseError) {
      logger.warn('[stripe-support] operation release failed; owner lease expires after five minutes', {
        userId,
        ownerToken,
        releaseError,
      });
    }
    throw error;
  }
}
