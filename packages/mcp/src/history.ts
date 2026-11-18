import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, lte, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { BOARD_TYPES } from '@boardsesh/public-api';
import { logbookTicks } from './db/schema';
import { LocalStore } from './storage';
import { McpError, type Profile } from './types';

const HistoryFilterSchema = z.object({
  since: z.iso.datetime().optional().describe('Inclusive UTC timestamp; defaults to 28 days ago.'),
  until: z.iso.datetime().optional().describe('Inclusive UTC timestamp; defaults to now.'),
  board: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(BOARD_TYPES))
    .optional()
    .describe(`Board type (case-insensitive): ${BOARD_TYPES.join(', ')}.`),
  angle: z.number().int().min(0).max(90).optional(),
  status: z.enum(['flash', 'send', 'attempt']).optional(),
  text: z.string().trim().min(1).max(200).optional().describe('Literal substring of climb name or your note.'),
});
export const SearchLogbookSchema = HistoryFilterSchema.extend({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(4096).optional().describe('Continue a previous page with the same filters.'),
});
export const SummaryLogbookSchema = HistoryFilterSchema;
export type SearchLogbookInput = z.input<typeof SearchLogbookSchema>;
export type SummaryLogbookInput = z.input<typeof SummaryLogbookSchema>;

const CursorSchema = z.object({
  accountId: z.string(),
  generation: z.string(),
  version: z.string(),
  fingerprint: z.string(),
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  climbedAt: z.number().int(),
  tickId: z.string().min(1),
});
type HistoryCursor = z.infer<typeof CursorSchema>;

function decodeCursor(cursor: string | undefined): HistoryCursor | undefined {
  if (!cursor) return undefined;
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown);
  } catch {
    throw new McpError('invalid_cursor', 'This history cursor is invalid. Start a new search.');
  }
}

function historyQuery(store: LocalStore, profile: Profile, input: SummaryLogbookInput, cursor?: HistoryCursor) {
  const current = store.assertAccount(profile);
  if (!current.scopes.includes('logbook:read'))
    throw new McpError('insufficient_scope', 'Reconnect with logbook:read to search history.');
  const state = store.getSyncState(profile);
  const now = Date.now();
  const filters = {
    ...input,
    since: input.since ?? cursor?.since ?? new Date(now - 28 * 86_400_000).toISOString(),
    until: input.until ?? cursor?.until ?? new Date(now).toISOString(),
  };
  if (Date.parse(filters.since) > Date.parse(filters.until))
    throw new McpError('invalid_input', 'since must not be later than until.');
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        since: filters.since,
        until: filters.until,
        board: filters.board ?? null,
        angle: filters.angle ?? null,
        status: filters.status ?? null,
        text: filters.text ?? null,
      }),
    )
    .digest('hex');
  if (
    cursor &&
    (cursor.accountId !== profile.accountId ||
      cursor.generation !== profile.generation ||
      cursor.version !== state.activeVersion ||
      cursor.fingerprint !== fingerprint)
  ) {
    throw new McpError('invalid_cursor', 'The account, history snapshot, or filters changed. Start a new search.');
  }
  const conditions: SQL[] = [
    eq(logbookTicks.accountId, profile.accountId),
    eq(logbookTicks.version, state.activeVersion ?? ''),
    gte(logbookTicks.climbedAt, Date.parse(filters.since)),
    lte(logbookTicks.climbedAt, Date.parse(filters.until)),
  ];
  if (filters.board) conditions.push(eq(logbookTicks.board, filters.board));
  if (filters.angle !== undefined) conditions.push(eq(logbookTicks.angle, filters.angle));
  if (filters.status) conditions.push(eq(logbookTicks.status, filters.status));
  if (filters.text) {
    conditions.push(
      sql`(instr(lower(coalesce(${logbookTicks.climbName}, '')), lower(${filters.text})) > 0 or instr(lower(coalesce(${logbookTicks.comment}, '')), lower(${filters.text})) > 0)`,
    );
  }
  return { filters, conditions, fingerprint, version: state.activeVersion, metadata: store.getSyncStatus(profile) };
}

export function searchLogbook(store: LocalStore, profile: Profile, rawInput: SearchLogbookInput = {}) {
  const { limit, cursor: rawCursor, ...input } = SearchLogbookSchema.parse(rawInput);
  const cursor = decodeCursor(rawCursor);
  const query = historyQuery(store, profile, input, cursor);
  if (cursor) {
    query.conditions.push(
      or(
        lt(logbookTicks.climbedAt, cursor.climbedAt),
        and(eq(logbookTicks.climbedAt, cursor.climbedAt), lt(logbookTicks.tickId, cursor.tickId)),
      )!,
    );
  }
  const rows = store.db
    .select({ tick: logbookTicks.tick, tickId: logbookTicks.tickId, climbedAt: logbookTicks.climbedAt })
    .from(logbookTicks)
    .where(and(...query.conditions))
    .orderBy(desc(logbookTicks.climbedAt), desc(logbookTicks.tickId))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  const nextCursor: HistoryCursor | null =
    hasMore && last && query.version
      ? {
          accountId: profile.accountId,
          generation: profile.generation,
          version: query.version,
          fingerprint: query.fingerprint,
          since: query.filters.since,
          until: query.filters.until,
          climbedAt: last.climbedAt,
          tickId: last.tickId,
        }
      : null;
  return {
    ...query.metadata,
    filters: query.filters,
    ticks: selected.map((row) => row.tick),
    hasMore,
    cursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString('base64url') : null,
  };
}

/** Aggregate in SQLite: history size never determines JS heap consumption. */
export function summarizeLogbook(store: LocalStore, profile: Profile, rawInput: SummaryLogbookInput = {}) {
  const input = SummaryLogbookSchema.parse(rawInput);
  const query = historyQuery(store, profile, input);
  const counts = {
    ticks: sql<number>`count(*)`,
    attempts: sql<number>`coalesce(sum(${logbookTicks.attempts}), 0)`,
    flashes: sql<number>`coalesce(sum(case when ${logbookTicks.status} = 'flash' then 1 else 0 end), 0)`,
    sends: sql<number>`coalesce(sum(case when ${logbookTicks.status} = 'send' then 1 else 0 end), 0)`,
    unsuccessfulTicks: sql<number>`coalesce(sum(case when ${logbookTicks.status} = 'attempt' then 1 else 0 end), 0)`,
  };
  const totals = store.db
    .select(counts)
    .from(logbookTicks)
    .where(and(...query.conditions))
    .get();
  const groups = store.db
    .select({
      board: logbookTicks.board,
      layout: logbookTicks.layout,
      angle: logbookTicks.angle,
      gradeLabel: logbookTicks.gradeLabel,
      gradeV: logbookTicks.gradeV,
      gradeFont: logbookTicks.gradeFont,
      ...counts,
    })
    .from(logbookTicks)
    .where(and(...query.conditions))
    .groupBy(
      logbookTicks.board,
      logbookTicks.layout,
      logbookTicks.angle,
      logbookTicks.gradeLabel,
      logbookTicks.gradeV,
      logbookTicks.gradeFont,
    )
    .orderBy(
      asc(logbookTicks.board),
      asc(logbookTicks.layout),
      asc(logbookTicks.angle),
      asc(logbookTicks.gradeV),
      asc(logbookTicks.gradeLabel),
      asc(logbookTicks.gradeFont),
    )
    .limit(201)
    .all();
  return {
    ...query.metadata,
    filters: query.filters,
    totals,
    groups: groups.slice(0, 200),
    groupsTruncated: groups.length > 200,
    gradeSource: 'Community grade at the last synchronization; boards and angles are kept separate.',
    attemptsMeaning: 'Sum of the attempts recorded on each tick, including send and flash ticks.',
  };
}
