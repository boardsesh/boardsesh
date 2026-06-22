// The three user-facing ascent-count sources and the pure selector that maps a
// climb's per-source counts onto the active source. Kept React-free so it can be
// unit-tested and reused by list rows, the community headline, and the chart.

export const ASCENT_COUNT_SOURCES = ['all', 'boardApp', 'boardsesh'] as const;

export type AscentCountSource = (typeof ASCENT_COUNT_SOURCES)[number];

export const DEFAULT_ASCENT_COUNT_SOURCE: AscentCountSource = 'all';

export function isAscentCountSource(value: unknown): value is AscentCountSource {
  return typeof value === 'string' && (ASCENT_COUNT_SOURCES as readonly string[]).includes(value);
}

/**
 * The per-source count fields a climb (or per-angle stats row) carries. All
 * nullable: the backend leaves a source null when it has no data for it (e.g. a
 * Tension climb has no Kilter count). `total` is the combined ascensionist count
 * we fall back to.
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
 * the Kilter and Aurora counts (the same source under two sync paths). When BOTH
 * are null we have no board-app signal, so fall back to the total.
 */
export function boardAppCount(fields: AscentCountFields): number {
  const { kilter, aurora, total } = fields;
  if (kilter == null && aurora == null) return total;
  return Math.max(kilter ?? 0, aurora ?? 0);
}

/**
 * Resolve the count to show for the chosen source.
 *
 * - `all` → the combined total.
 * - `boardApp` → max(kilter, aurora); falls back to the total when both are null.
 * - `boardsesh` → the Boardsesh count; falls back to the total when null, but a
 *   real 0 stays 0 (someone could have a board-app climb with no Boardsesh ticks).
 */
export function selectSourceCount(fields: AscentCountFields, source: AscentCountSource): number {
  switch (source) {
    case 'all':
      return fields.total;
    case 'boardApp':
      return boardAppCount(fields);
    case 'boardsesh':
      return fields.boardsesh ?? fields.total;
  }
}
