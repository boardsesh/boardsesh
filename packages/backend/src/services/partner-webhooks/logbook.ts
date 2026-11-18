import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { oauthConnections } from '@boardsesh/db/schema/auth';
import {
  logbookChanges,
  oauthClientWebhooks,
  partnerWebhookDebounce,
  partnerWebhookFeedState,
} from '@boardsesh/db/schema/app';
import { db, type Database } from '../../db/client';
import { readLogbookFeedState } from '../logbook-feed';
import { enqueuePartnerWebhookEvent } from './events';
import { liveWebhookScopeCondition } from './authorization';
import { enqueueChangedWorkoutResults, markChangedWorkoutResults } from './workout-results-changed';

/** Durable cursor and pending bits preserve the trailing change inside a debounce window. */
async function produceLogbookWebhookPage(database: Database): Promise<boolean> {
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '2s', true), set_config('idle_in_transaction_session_timeout', '10s', true)`,
      );
      const feed = await readLogbookFeedState(transaction);
      const initialized = await transaction
        .insert(partnerWebhookFeedState)
        .values({ id: 1, feedGeneration: feed.generation, txid: feed.horizon, seq: '0' })
        .onConflictDoNothing()
        .returning({ id: partnerWebhookFeedState.id });
      const [cursor] = await transaction
        .select()
        .from(partnerWebhookFeedState)
        .where(eq(partnerWebhookFeedState.id, 1))
        .for('update');
      const stale =
        initialized.length > 0 ||
        cursor.feedGeneration !== feed.generation ||
        BigInt(cursor.txid) < BigInt(feed.prunedThrough.txid) ||
        (cursor.txid === feed.prunedThrough.txid && BigInt(cursor.seq) < BigInt(feed.prunedThrough.seq));
      // On initialization, restore or pruning, notify every subscriber once and
      // resume at the horizon rather than spending days replaying retained history.
      const position = stale ? { txid: feed.horizon, seq: '0' } : { txid: cursor.txid, seq: cursor.seq };
      const changes = await transaction
        .select({
          userId: logbookChanges.userId,
          tickUuid: logbookChanges.tickUuid,
          txid: sql<string>`${logbookChanges.txid}::text`,
          seq: sql<string>`${logbookChanges.seq}::text`,
        })
        .from(logbookChanges)
        .where(
          and(
            sql`${logbookChanges.txid} < ${feed.horizon}::xid8`,
            sql`(${logbookChanges.txid}, ${logbookChanges.seq}) > (${position.txid}::xid8, ${position.seq}::bigint)`,
          ),
        )
        .orderBy(asc(logbookChanges.txid), asc(logbookChanges.seq))
        .limit(1000);
      const changedUsers = [...new Set(changes.map((change) => change.userId))];
      if (stale || changedUsers.length > 0) {
        // INSERT SELECT marks every matching connection without fetching an unbounded roster.
        const eligible = transaction
          .select({
            connectionId: oauthConnections.id,
            connectionGeneration: oauthConnections.generation,
            lastEnqueuedAt: sql<Date>`now() - interval '1 minute'`.as('last_enqueued_at'),
            pending: sql<boolean>`true`.as('pending'),
          })
          .from(oauthConnections)
          .innerJoin(oauthClientWebhooks, eq(oauthClientWebhooks.clientId, oauthConnections.clientId))
          .where(
            and(
              isNull(oauthConnections.revokedAt),
              sql`${oauthConnections.connectedAt} is not null`,
              eq(oauthClientWebhooks.enabled, true),
              liveWebhookScopeCondition('logbook:read'),
              sql`'logbook.changed' = any(${oauthClientWebhooks.events})`,
              stale ? undefined : inArray(oauthConnections.userId, changedUsers),
            ),
          );
        await transaction
          .insert(partnerWebhookDebounce)
          .select(eligible)
          .onConflictDoUpdate({
            target: [partnerWebhookDebounce.connectionId, partnerWebhookDebounce.connectionGeneration],
            set: { pending: true },
          });
      }
      const ready = await transaction
        .select({ debounce: partnerWebhookDebounce, clientId: oauthConnections.clientId })
        .from(partnerWebhookDebounce)
        .innerJoin(
          oauthConnections,
          and(
            eq(oauthConnections.id, partnerWebhookDebounce.connectionId),
            eq(oauthConnections.generation, partnerWebhookDebounce.connectionGeneration),
          ),
        )
        .where(
          and(
            eq(partnerWebhookDebounce.pending, true),
            lt(partnerWebhookDebounce.lastEnqueuedAt, new Date(Date.now() - 60_000)),
            isNull(oauthConnections.revokedAt),
          ),
        )
        .orderBy(asc(partnerWebhookDebounce.lastEnqueuedAt))
        .limit(100);
      for (const { debounce, clientId } of ready) {
        await enqueuePartnerWebhookEvent(transaction, {
          clientId,
          connectionId: debounce.connectionId,
          connectionGeneration: debounce.connectionGeneration,
          type: 'logbook.changed',
        });
        await transaction
          .update(partnerWebhookDebounce)
          .set({ pending: false, lastEnqueuedAt: new Date() })
          .where(
            and(
              eq(partnerWebhookDebounce.connectionId, debounce.connectionId),
              eq(partnerWebhookDebounce.connectionGeneration, debounce.connectionGeneration),
            ),
          );
      }
      // The same page also re-sends workout.completed to apps whose finished
      // workout's results it changed (docs/partner-api.md, section 5).
      await markChangedWorkoutResults(transaction, changes);
      const readyWorkouts = await enqueueChangedWorkoutResults(transaction);
      const last = changes.at(-1);
      await transaction
        .update(partnerWebhookFeedState)
        .set({
          feedGeneration: feed.generation,
          txid: changes.length === 1000 && last ? last.txid : feed.horizon,
          seq: changes.length === 1000 && last ? last.seq : '0',
        })
        .where(eq(partnerWebhookFeedState.id, 1));
      return changes.length === 1000 || ready.length === 100 || readyWorkouts === 100;
    },
    { isolationLevel: 'repeatable read' },
  );
}

export async function produceLogbookWebhookEvents(database: Database = db): Promise<void> {
  for (let page = 0; page < 10; page++) {
    if (!(await produceLogbookWebhookPage(database))) break;
  }
}
