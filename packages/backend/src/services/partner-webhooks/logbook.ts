import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { oauthConnections } from '@boardsesh/db/schema/auth';
import { oauthClientWebhooks, partnerWebhookDebounce, partnerWebhookFeedState } from '@boardsesh/db/schema/app';
import { db, type Database } from '../../db/client';
import { readLogbookFeedState } from '../logbook-feed';
import { enqueuePartnerWebhookEvent } from './events';
import { liveWebhookScopeCondition } from './authorization';

/** Durable cursor and pending bit preserve the trailing change inside a debounce window. */
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
      const changes = await transaction.execute<{ userId: string; txid: string; seq: string }>(sql`
        SELECT changes.user_id AS "userId", changes.txid::text AS txid, changes.seq::text AS seq
        FROM (
          SELECT user_id, txid, seq FROM public.logbook_changes
          WHERE txid < ${feed.horizon}::xid8 AND (txid,seq) > (${position.txid}::xid8,${position.seq}::bigint)
          UNION ALL
          SELECT user_id, txid, seq FROM public.logbook_session_changes
          WHERE txid < ${feed.horizon}::xid8 AND (txid,seq) > (${position.txid}::xid8,${position.seq}::bigint)
        ) changes ORDER BY changes.txid, changes.seq LIMIT 1000`);
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
      const last = changes.at(-1);
      await transaction
        .update(partnerWebhookFeedState)
        .set({
          feedGeneration: feed.generation,
          txid: changes.length === 1000 && last ? last.txid : feed.horizon,
          seq: changes.length === 1000 && last ? last.seq : '0',
        })
        .where(eq(partnerWebhookFeedState.id, 1));
      return changes.length === 1000 || ready.length === 100;
    },
    { isolationLevel: 'repeatable read' },
  );
}

export async function produceLogbookWebhookEvents(database: Database = db): Promise<void> {
  for (let page = 0; page < 10; page++) {
    if (!(await produceLogbookWebhookPage(database))) break;
  }
}
