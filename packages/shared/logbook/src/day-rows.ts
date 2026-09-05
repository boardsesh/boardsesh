// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { AscentFeedInput } from './to-ascent-feed-input';

dayjs.extend(utc);

/**
 * `boardsesh_ticks.climbed_at` is a naive `timestamp` column serialized with no
 * `Z` suffix; parsing it as local time would shift day buckets by the device's
 * UTC offset. Parse as UTC, then convert to local — the same recovery
 * `@boardsesh/profile-stats`' `parseTickTime` does. Duplicated here (3 lines)
 * rather than importing it so this package doesn't take profile-stats' whole
 * transitive dependency surface for one date wrapper; if the tick timestamp
 * format ever changes, update both.
 */
function parseTickTimeLocal(climbedAt: string) {
  if (!climbedAt) throw new TypeError('day bucketing requires a non-empty timestamp string');
  return dayjs.utc(climbedAt).local();
}

/**
 * Day-divider derivation for the logbook list. The logbook renders date anchors
 * (NOT session cards — sessions are the Sessions tab's job) above runs of
 * same-day ascents, but only when the feed is date-ordered: grouping a
 * hardest-first list by day would be noise. Pure and platform-free so web can
 * reuse it and the edge cases (page-boundary days, duplicate rows from offset
 * pagination, midnight) stay unit-testable.
 */

/** The ascent fields day bucketing reads; AscentFeedItem satisfies this. */
export type LogbookDayItem = {
  uuid: string;
  status: 'flash' | 'send' | 'attempt';
  climbedAt: string;
  /**
   * Display label of the wall this ascent happened on ("Alex's board 35°",
   * "Kilter Homewall 40°"), provided by the caller (label derivation needs the
   * platform's board metadata). Drives the divider wall context: a uniform
   * complete day carries it on the day divider, a mixed day gets sub-dividers,
   * and covered rows can drop it from their own meta line.
   */
  wall?: string;
  difficulty?: number | null;
  consensusDifficulty?: number | null;
  difficultyName?: string | null;
  consensusDifficultyName?: string | null;
};

export type LogbookDayStats = {
  /** Ascents logged that day (all statuses). */
  climbCount: number;
  /** Sends that day; flashes count as sends (flash ⊂ send). */
  sendCount: number;
  /** Hardest send of the day (effective grade), for the "top V8" rollup. */
  topDifficulty: number | null;
  topDifficultyName: string | null;
};

export type LogbookListRow<T extends LogbookDayItem = LogbookDayItem> =
  | {
      type: 'divider';
      /** Stable list key (day key + defensive occurrence suffix). */
      key: string;
      /** Local calendar day of the run, `YYYY-MM-DD`. */
      dayKey: string;
      /** Local start-of-day timestamp (ms), for label formatting. */
      dayStartMs: number;
      /**
       * The day's wall, when the COMPLETE day is wall-uniform (an incomplete
       * day could still gain a second wall from the next page). Mixed days
       * carry null here and get subdivider rows instead.
       */
      wallLabel: string | null;
      /**
       * Rollup stats, or null while the day is still loading. A day is complete
       * once an item from ANOTHER day follows it, or the feed has no more pages
       * — 20-item pages mean a day can straddle a page boundary, and a partial
       * count would lie (including to screen readers). The oldest loaded day
       * shows its date without stats until its boundary arrives.
       */
      stats: LogbookDayStats | null;
    }
  | {
      /** Wall-context anchor inside a mixed day — one per consecutive wall run. */
      type: 'subdivider';
      key: string;
      wallLabel: string;
    }
  | {
      type: 'entry';
      key: string;
      item: T;
      /**
       * True when a divider or subdivider above already names this row's wall,
       * so the row can drop board+angle from its own meta line. False on
       * incomplete uniform days and whenever dividers are off — the row then
       * carries its own label (row content must never silently lose the wall).
       */
      wallCovered: boolean;
    };

/**
 * Dividers only make sense on a date-ordered feed: the `recent` preset, or a
 * custom sort whose PRIMARY field is the ascent date (either direction — the
 * run-based bucketing below is direction-agnostic). Keyed off the EFFECTIVE
 * feed input (what the query actually runs), not raw persisted sort state —
 * with the logbook-filters flag off the persisted sort is ignored and the feed
 * is date-desc regardless. A climb-name search does NOT suppress dividers:
 * `climbName` is a filter; the result set is still a timeline.
 */
export function shouldShowLogbookDividers(input: Pick<AscentFeedInput, 'sortBy'>): boolean {
  return input.sortBy === 'recent' || input.sortBy === 'date';
}

/**
 * Local calendar day of a tick, `YYYY-MM-DD`. Goes through `parseTickTime` so
 * the naive-UTC `climbed_at` string is converted to the device's local time
 * BEFORE the day is cut — a 23:30 UTC tick in UTC-5 belongs to the earlier
 * local day.
 */
export function logbookDayKey(climbedAt: string): string {
  return parseTickTimeLocal(climbedAt).format('YYYY-MM-DD');
}

export type LogbookDayDescription = {
  kind: 'today' | 'yesterday' | 'thisYear' | 'older';
};

/**
 * Classify a day for label rendering ("Today" / "Yesterday" / weekday+date /
 * dated with year). Operates on the LOCAL start-of-day timestamp produced by
 * `buildLogbookListRows` — never re-parses the day key as UTC. `now` is
 * injected so the caller can re-evaluate on focus: a screen left mounted across
 * midnight must stop calling yesterday "Today".
 */
export function describeLogbookDay(dayStartMs: number, now: number): LogbookDayDescription {
  const day = dayjs(dayStartMs);
  const today = dayjs(now);
  if (day.isSame(today, 'day')) return { kind: 'today' };
  if (day.isSame(today.subtract(1, 'day'), 'day')) return { kind: 'yesterday' };
  if (day.isSame(today, 'year')) return { kind: 'thisYear' };
  return { kind: 'older' };
}

function effectiveDifficulty(item: LogbookDayItem): number | null {
  return item.difficulty ?? item.consensusDifficulty ?? null;
}

function effectiveDifficultyName(item: LogbookDayItem): string | null {
  if (item.difficulty != null) return item.difficultyName ?? null;
  if (item.consensusDifficulty != null) return item.consensusDifficultyName ?? null;
  return null;
}

function statsForRun(run: readonly LogbookDayItem[]): LogbookDayStats {
  let sendCount = 0;
  let topDifficulty: number | null = null;
  let topDifficultyName: string | null = null;
  for (const item of run) {
    if (item.status === 'attempt') continue;
    sendCount += 1;
    const difficulty = effectiveDifficulty(item);
    if (difficulty != null && (topDifficulty == null || difficulty > topDifficulty)) {
      topDifficulty = difficulty;
      topDifficultyName = effectiveDifficultyName(item);
    }
  }
  return { climbCount: run.length, sendCount, topDifficulty, topDifficultyName };
}

/** Dedupe a flat entry list by uuid — the dividers-off path needs it too. */
export function dedupeLogbookItems<T extends LogbookDayItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    deduped.push(item);
  }
  return deduped;
}

/**
 * Flatten a date-ordered ascent page list into divider + entry rows.
 *
 * - **Dedupes by uuid** first: offset pagination can return the same row on two
 *   adjacent pages when offsets shift mid-pagination (and swipe-delete makes
 *   offset shifts a first-class action) — duplicate FlashList keys would throw.
 * - Groups consecutive same-day runs (date-ordered input keeps days contiguous;
 *   a defensive occurrence suffix keeps divider keys unique if they ever
 *   aren't).
 * - `hasMore` drives the complete-day rule documented on `stats`.
 */
export function buildLogbookListRows<T extends LogbookDayItem>(
  items: readonly T[],
  options: { hasMore: boolean },
): LogbookListRow<T>[] {
  const deduped = dedupeLogbookItems(items);
  const rows: LogbookListRow<T>[] = [];
  const dayOccurrences = new Map<string, number>();

  // Explicit parameters (not captured mutable outer state) so the flush can't
  // silently read a half-updated run if this loop is ever reordered.
  const flushRun = (run: readonly T[], dayKey: string, isLastRun: boolean) => {
    if (run.length === 0) return;
    const occurrence = dayOccurrences.get(dayKey) ?? 0;
    dayOccurrences.set(dayKey, occurrence + 1);
    const complete = !isLastRun || !options.hasMore;
    const keySuffix = occurrence === 0 ? dayKey : `${dayKey}-${occurrence}`;

    // Wall context. Items without a wall label count as their own "wall" so a
    // labelled/unlabelled mix still splits truthfully.
    const walls = new Set(run.map((item) => item.wall ?? ''));
    const uniformWall = walls.size === 1 ? (run[0].wall ?? null) : null;
    // A uniform-so-far but INCOMPLETE day may still gain a second wall from the
    // next page, so the divider only claims the wall once the day is complete.
    const dividerWall = complete && uniformWall != null ? uniformWall : null;
    // Mixed days split into subdividers — those boundaries are definite even on
    // an incomplete day (loaded runs can only be subdivided further, not merged).
    const mixed = walls.size > 1;

    rows.push({
      type: 'divider',
      key: `day-${keySuffix}`,
      dayKey,
      dayStartMs: parseTickTimeLocal(run[0].climbedAt).startOf('day').valueOf(),
      wallLabel: dividerWall,
      stats: complete ? statsForRun(run) : null,
    });

    let segmentWall: string | null = null;
    let segmentIndex = 0;
    for (const item of run) {
      const itemWall = item.wall ?? '';
      if (mixed && itemWall !== segmentWall) {
        segmentWall = itemWall;
        // An unlabelled segment gets no (empty) anchor; its entries stay
        // uncovered below instead.
        if (itemWall !== '') {
          rows.push({
            type: 'subdivider',
            key: `sub-${keySuffix}-${segmentIndex}`,
            wallLabel: itemWall,
          });
        }
        segmentIndex += 1;
      }
      // Covered = a subdivider names this row's wall, or the complete-day
      // divider does. Unlabelled items under a mixed day sit beneath an empty
      // subdivider and stay uncovered so their (absent) label can't be implied.
      const wallCovered = mixed ? item.wall != null : dividerWall != null;
      rows.push({ type: 'entry', key: item.uuid, item, wallCovered });
    }
  };

  let run: T[] = [];
  let runDayKey = '';
  for (const item of deduped) {
    const dayKey = logbookDayKey(item.climbedAt);
    if (dayKey !== runDayKey && run.length > 0) {
      flushRun(run, runDayKey, false);
      run = [];
    }
    runDayKey = dayKey;
    run.push(item);
  }
  flushRun(run, runDayKey, true);

  return rows;
}
