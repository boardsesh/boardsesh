import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbIngestSkips } from '@boardsesh/db/schema';

import type { KilterCatalogClimb } from '../api/kilter-rest';
import type { GripsDecodeResult, KilterSkipReason } from './catalog-parse';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const CHUNK = 500;

/**
 * A climb the catalog read but could not turn into a board_climbs row.
 *
 * Before this existed the ingest counted these and moved on, so a climb could
 * be missing from Boardsesh forever with nothing to show for it but a rotating
 * log line (issue #3523). `rawHolds` carries the verbatim upstream hold string
 * so the next encoding drift can be decoded from rows we already have.
 */
export type ClimbIngestSkip = {
  boardType: string;
  climbUuid: string;
  layoutId: number | null;
  sourceLayoutUuid: string | null;
  reason: KilterSkipReason;
  detail: string | null;
  rawHolds: string;
  framesCount: number | null;
  climbName: string | null;
  setterUsername: string | null;
};

export type SkipContext = {
  boardType: string;
  layoutId: number | null;
  sourceLayoutUuid: string | null;
};

/** The reason-specific half of a skip row, split out so it stays exhaustive. */
function skipDetail(failure: Extract<GripsDecodeResult, { ok: false }>): string {
  switch (failure.reason) {
    case 'unplaceable_hole':
      return `holeId=${failure.holeId}`;
    case 'unparsable_concat':
      return `offset=${failure.offset}`;
    case 'frame_out_of_range':
      return `frame=${failure.frame}`;
  }
}

/**
 * Turn a failed decode into the row we persist. Pure — the whole point is that
 * the interesting logic (which reason, what detail, what raw payload) is
 * testable without a database.
 */
export function buildSkipRow(
  climb: KilterCatalogClimb,
  failure: Extract<GripsDecodeResult, { ok: false }>,
  context: SkipContext,
): ClimbIngestSkip {
  return {
    boardType: context.boardType,
    climbUuid: climb.climbUuid,
    layoutId: context.layoutId,
    sourceLayoutUuid: context.sourceLayoutUuid,
    reason: failure.reason,
    detail: skipDetail(failure),
    rawHolds: climb.climbConcat,
    framesCount: climb.frameCount ?? null,
    climbName: emptyToNull(climb.name),
    setterUsername: emptyToNull(climb.username),
  };
}

/** Upstream sends '' for an absent name; store that as NULL, not a blank. */
function emptyToNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

/** One-line summary of a skip, for the per-run log. */
export function describeSkip(skip: ClimbIngestSkip): string {
  return `${skip.climbUuid} (${skip.reason}${skip.detail ? ` ${skip.detail}` : ''})`;
}

/**
 * Group skips by reason for the per-run log line, so a systemic break reads as
 * "412 unparsable_concat" instead of ten arbitrary uuids.
 */
export function summarizeSkipReasons(skips: ClimbIngestSkip[]): Array<{ reason: KilterSkipReason; count: number }> {
  const counts = new Map<KilterSkipReason, number>();
  for (const skip of skips) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

async function chunked<T>(rows: T[], run: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let index = 0; index < rows.length; index += CHUNK) {
    await run(rows.slice(index, index + CHUNK));
  }
}

/**
 * The climbs currently sitting unresolved in the backlog, keyed by lowercased
 * uuid so a catalog row still matches if upstream changes the casing — mapped
 * to the uuid *as stored*, which is what `markSkipsResolved` must match on for
 * its primary-key lookup to hit.
 */
export async function loadOpenSkips(db: DrizzleDb, boardType: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ climbUuid: boardClimbIngestSkips.climbUuid })
    .from(boardClimbIngestSkips)
    .where(and(eq(boardClimbIngestSkips.boardType, boardType), isNull(boardClimbIngestSkips.resolvedAt)));
  return new Map(rows.map((row) => [row.climbUuid.toLowerCase(), row.climbUuid]));
}

/**
 * Record this run's skips. Re-skipping a climb refreshes `last_seen_at` and
 * re-opens the row (`resolved_at` back to null) — a climb that decoded once and
 * stopped is exactly the drift this table exists to make visible.
 */
export async function persistSkips(db: DrizzleDb, skips: ClimbIngestSkip[]): Promise<void> {
  await chunked(skips, async (chunk) => {
    await db
      .insert(boardClimbIngestSkips)
      .values(chunk)
      .onConflictDoUpdate({
        target: [boardClimbIngestSkips.boardType, boardClimbIngestSkips.climbUuid],
        set: {
          layoutId: sql`excluded.layout_id`,
          sourceLayoutUuid: sql`excluded.source_layout_uuid`,
          reason: sql`excluded.reason`,
          detail: sql`excluded.detail`,
          rawHolds: sql`excluded.raw_holds`,
          framesCount: sql`excluded.frames_count`,
          climbName: sql`excluded.climb_name`,
          setterUsername: sql`excluded.setter_username`,
          lastSeenAt: sql`now()`,
          resolvedAt: null,
        },
      });
  });
}

/**
 * Stamp `resolved_at` on climbs a later run managed to ingest. Never deletes —
 * the resolved rows are the record of what a decoder fix actually recovered.
 */
export async function markSkipsResolved(db: DrizzleDb, boardType: string, climbUuids: string[]): Promise<void> {
  await chunked(climbUuids, async (chunk) => {
    await db
      .update(boardClimbIngestSkips)
      .set({ resolvedAt: sql`now()` })
      .where(
        and(
          eq(boardClimbIngestSkips.boardType, boardType),
          isNull(boardClimbIngestSkips.resolvedAt),
          inArray(boardClimbIngestSkips.climbUuid, chunk),
        ),
      );
  });
}

export type BacklogQuery = {
  boardType: string;
  /** Typed, so a misspelled reason is a compile error rather than an empty result. */
  reason?: KilterSkipReason;
  limit: number;
  includeResolved: boolean;
};

/** Read the backlog for the `kilter-sync backlog` report. */
export async function loadBacklog(db: DrizzleDb, query: BacklogQuery) {
  const filters = [eq(boardClimbIngestSkips.boardType, query.boardType)];
  if (!query.includeResolved) filters.push(isNull(boardClimbIngestSkips.resolvedAt));
  if (query.reason) filters.push(eq(boardClimbIngestSkips.reason, query.reason));

  return db
    .select({
      climbUuid: boardClimbIngestSkips.climbUuid,
      climbName: boardClimbIngestSkips.climbName,
      setterUsername: boardClimbIngestSkips.setterUsername,
      layoutId: boardClimbIngestSkips.layoutId,
      sourceLayoutUuid: boardClimbIngestSkips.sourceLayoutUuid,
      reason: boardClimbIngestSkips.reason,
      detail: boardClimbIngestSkips.detail,
      framesCount: boardClimbIngestSkips.framesCount,
      rawHolds: boardClimbIngestSkips.rawHolds,
      firstSeenAt: boardClimbIngestSkips.firstSeenAt,
      lastSeenAt: boardClimbIngestSkips.lastSeenAt,
      resolvedAt: boardClimbIngestSkips.resolvedAt,
    })
    .from(boardClimbIngestSkips)
    .where(and(...filters))
    .orderBy(asc(boardClimbIngestSkips.reason), desc(boardClimbIngestSkips.lastSeenAt))
    .limit(query.limit);
}
