// The three user-facing ascent-count sources and the pure selector that maps a
// climb's per-source counts onto the active source. Kept React-free so it can be
// unit-tested and reused by list rows, the community headline, and the chart.

import type { AscentCountSource } from '@boardsesh/shared-schema';

// Re-exported so existing imports of `AscentCountSource` from this module keep
// working, but the canonical definition is the GraphQL `AscentCountSource` enum
// (shared-schema) — the runtime list below is `satisfies`-checked against it so
// it can't drift to a value the schema/backend would reject.
export type { AscentCountSource };

export const ASCENT_COUNT_SOURCES = ['all', 'boardApp', 'boardsesh'] as const satisfies readonly AscentCountSource[];

export const DEFAULT_ASCENT_COUNT_SOURCE: AscentCountSource = 'all';

export function isAscentCountSource(value: unknown): value is AscentCountSource {
  return typeof value === 'string' && (ASCENT_COUNT_SOURCES as readonly string[]).includes(value);
}

/**
 * The per-source count fields a climb (or per-angle stats row) carries.
 *
 * The distinction between `undefined` and `null` is load-bearing:
 * - `undefined` — this shape never carried the per-source split (queue / tick /
 *   board-presence climbs that only select `ascensionist_count`). We don't know
 *   the breakdown, so the selector falls back to the combined `total`.
 * - `null` — the backend returned the field and it has no data: a real zero.
 *   Migration 0099 leaves `boardsesh_ascensionist_count` NULL for every climb
 *   with no Boardsesh ticks, so NULL means "zero senders", not "unknown". The
 *   search sort agrees (`COALESCE(boardsesh, 0)` /
 *   `GREATEST(COALESCE(kilter,0), COALESCE(aurora,0))`), so we mirror it: a
 *   present-but-null source counts as 0, never the total.
 */
export type AscentCountFields = {
  /** The combined total — `ascensionist_count`. Always present. */
  total: number;
  kilter?: number | null;
  aurora?: number | null;
  boardsesh?: number | null;
};

/**
 * "Board app" = the count from the board's own app, modelled as the larger of
 * the Kilter and Aurora counts (the same source under two sync paths). Both
 * fields ABSENT (undefined) means this shape carries no split, so fall back to
 * the total; a present-but-null source is a real 0 (mirrors the search sort
 * `GREATEST(COALESCE(kilter,0), COALESCE(aurora,0))`).
 */
export function boardAppCount(fields: AscentCountFields): number {
  const { kilter, aurora, total } = fields;
  if (kilter === undefined && aurora === undefined) return total;
  return Math.max(kilter ?? 0, aurora ?? 0);
}

/**
 * Resolve the count to show for the chosen source.
 *
 * - `all` → the combined total.
 * - `boardApp` → max(kilter, aurora); falls back to the total only when both
 *   fields are absent (undefined). A present-but-null source counts as 0.
 * - `boardsesh` → the Boardsesh count; falls back to the total only when the
 *   field is absent (undefined). A present null/0 stays 0 — NULL means "no
 *   Boardsesh senders", not "unknown", so we never show the Aurora total here.
 */
export function selectSourceCount(fields: AscentCountFields, source: AscentCountSource): number {
  switch (source) {
    case 'all':
      return fields.total;
    case 'boardApp':
      return boardAppCount(fields);
    case 'boardsesh':
      return fields.boardsesh === undefined ? fields.total : (fields.boardsesh ?? 0);
  }
}
