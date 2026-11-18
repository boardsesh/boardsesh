import { z } from 'zod';
import { GradeSchema, TickClimbSchema, TickSchema } from '@boardsesh/public-api';
import { and, eq, ne } from 'drizzle-orm';
import { logbookStates, logbookTicks } from './db/schema';
import { LocalStore } from './storage';
import { McpError, PartnerError, type PartnerClient, type Profile } from './types';

const ClientGradeSchema = z.object(GradeSchema.shape);
/** Public v1 responses are additive; consumer parsing deliberately differs from server assertions. */
export const ClientTickSchema = z.object({
  ...TickSchema.shape,
  status: z.string().transform((status) => (status === 'flash' || status === 'send' ? status : 'attempt')),
  grade: ClientGradeSchema.nullable(),
  comment: z.string().nullable(),
  climb: z.object({
    ...TickClimbSchema.shape,
    board: z.object({ type: z.string().min(1), layout: z.string() }),
    grade: ClientGradeSchema.nullable(),
  }),
});
export type ClientTick = z.infer<typeof ClientTickSchema>;

const FeedPageSchema = z.object({
  changes: z.array(z.object({ type: z.string().min(1) }).passthrough()).max(200),
  cursor: z.string().min(1),
  hasMore: z.boolean(),
});

type ParsedChange = { type: 'tick'; tick: ClientTick } | { type: 'tick.deleted'; id: string };

function parsePage(payload: unknown) {
  const page = FeedPageSchema.parse(payload);
  const changes: ParsedChange[] = [];
  for (const change of page.changes) {
    if (change.type === 'tick') changes.push({ type: 'tick', tick: ClientTickSchema.parse(change.tick) });
    else if (change.type === 'tick.deleted')
      changes.push({ type: 'tick.deleted', id: z.string().min(1).parse(change.id) });
  }
  return { ...page, changes };
}

/** A bounded pull. Caller owns the profile lock for this invocation. */
export async function syncLogbook(
  store: LocalStore,
  client: PartnerClient,
  profile: Profile,
  { maxPages = 10 }: { maxPages?: number } = {},
) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
    throw new McpError('invalid_input', 'maxPages must be between 1 and 10.');
  const current = store.assertAccount(profile);
  if (!current.scopes.includes('logbook:read'))
    throw new McpError('insufficient_scope', 'Reconnect with logbook:read to sync history.');
  let pages = 0;
  let restarted = false;
  let hasMore = true;
  let started = false;
  try {
    while (pages < maxPages && hasMore) {
      const state = store.beginSync(profile);
      started = true;
      const query = new URLSearchParams({ limit: '200' });
      if (state.cursor) query.set('cursor', state.cursor);
      let payload: unknown;
      try {
        payload = await client.request(profile, `/v1/logbook/changes?${query}`);
      } catch (error) {
        if (error instanceof PartnerError && error.status === 410) {
          store.resetSync(profile);
          if (!restarted) {
            restarted = true;
            continue;
          }
        }
        throw error;
      }
      const page = parsePage(payload);
      if (!store.assertAccount(profile).scopes.includes('logbook:read'))
        throw new McpError('insufficient_scope', 'Reconnect with logbook:read to sync history.');
      const version = state.stagingVersion ?? state.activeVersion;
      if (!version) throw new McpError('sync_state_invalid', 'Logbook snapshot has no storage generation.');
      store.db.transaction((transaction) => {
        for (const change of page.changes) {
          if (change.type === 'tick.deleted') {
            transaction
              .delete(logbookTicks)
              .where(
                and(
                  eq(logbookTicks.accountId, profile.accountId),
                  eq(logbookTicks.version, version),
                  eq(logbookTicks.tickId, change.id),
                ),
              )
              .run();
          } else {
            const tick = change.tick;
            const record = {
              accountId: profile.accountId,
              version,
              tickId: tick.id,
              climbedAt: Date.parse(tick.climbedAt),
              board: tick.climb.board.type,
              layout: tick.climb.board.layout,
              angle: tick.angle,
              status: tick.status,
              attempts: tick.attempts,
              climbId: tick.climb.id,
              climbName: tick.climb.name,
              comment: tick.comment,
              gradeLabel: tick.climb.grade?.label ?? null,
              gradeV: tick.climb.grade?.v ?? null,
              gradeFont: tick.climb.grade?.font ?? null,
              tick,
            };
            transaction
              .insert(logbookTicks)
              .values(record)
              .onConflictDoUpdate({
                target: [logbookTicks.accountId, logbookTicks.version, logbookTicks.tickId],
                set: record,
              })
              .run();
          }
        }
        if (!page.hasMore && state.stagingVersion) {
          transaction
            .delete(logbookTicks)
            .where(and(eq(logbookTicks.accountId, profile.accountId), ne(logbookTicks.version, version)))
            .run();
        }
        transaction
          .update(logbookStates)
          .set({
            cursor: page.cursor,
            catchingUp: page.hasMore,
            ...(!page.hasMore
              ? {
                  activeVersion: version,
                  stagingVersion: null,
                  stagingOwner: null,
                  fullSyncRequired: false,
                  lastSyncedAt: new Date().toISOString(),
                }
              : {}),
          })
          .where(eq(logbookStates.accountId, profile.accountId))
          .run();
      });
      pages += 1;
      hasMore = page.hasMore;
    }
  } finally {
    // A handled error has a valid last committed checkpoint, just like a
    // bounded yield. Only a process crash should leave the dirty marker set.
    const active = store.getProfile();
    if (
      started &&
      active?.authStatus === 'connected' &&
      active.generation === profile.generation &&
      active.accountId === profile.accountId &&
      active.subject === profile.subject &&
      active.issuer === profile.issuer &&
      active.clientId === profile.clientId
    )
      store.finishSync(profile);
  }
  return { ...store.getSyncStatus(profile), pages, hasMore };
}
