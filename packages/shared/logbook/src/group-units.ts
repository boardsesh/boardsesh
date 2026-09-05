// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { displayedAttemptCount } from './row-meta';

/**
 * Day-scoped repeat grouping: the logbook renders one row per (climb, day)
 * group, and these pure rules decide what that row shows. Agreed semantics
 * (PR #3350 thread): the BEST outcome of the day wins the row — its status
 * glyph, grade, stars, note and beta markers all come from that entry — and
 * the tries SUM across the day's entries. The row always shows that day's
 * tries; lifetime totals live in the climb's own logbook view.
 */

type GroupableStatus = 'flash' | 'send' | 'attempt';

/** The entry fields grouping reads; AscentFeedItem satisfies this. */
export type GroupableEntry = {
  uuid: string;
  status: GroupableStatus;
  climbedAt: string;
  attemptCount: number;
  /** The climber's own grade, when logged — richer entries win status ties. */
  difficulty?: number | null;
};

const STATUS_RANK: Record<GroupableStatus, number> = { flash: 3, send: 2, attempt: 1 };

/**
 * The entry that represents the group: best outcome first (flash > send >
 * attempt — a flash is the cleaner story than a later redpoint), latest
 * `climbedAt` breaking ties. Robust to input order even though the resolver
 * returns items newest-first.
 */
export function pickBestGroupEntry<T extends GroupableEntry>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pickBestGroupEntry requires a non-empty group');
  }
  // Tie-breaks within a status rank: a GRADED entry beats an ungraded one
  // (an ungraded quick repeat must not demote the row to the crowd's grade),
  // then the latest wins. Stored naive timestamps share one format, so
  // lexicographic order is chronological — the same assumption the resolver's
  // ORDER BY makes.
  const richness = (entry: GroupableEntry) => (entry.difficulty != null ? 1 : 0);
  let best = items[0];
  for (const item of items.slice(1)) {
    const rankDelta = STATUS_RANK[item.status] - STATUS_RANK[best.status];
    const richnessDelta = richness(item) - richness(best);
    if (
      rankDelta > 0 ||
      (rankDelta === 0 && richnessDelta > 0) ||
      (rankDelta === 0 && richnessDelta === 0 && item.climbedAt > best.climbedAt)
    ) {
      best = item;
    }
  }
  return best;
}

/**
 * The day's total tries across the group's entries, flooring each at 1 the
 * same way a single row displays an imported 0-attempt tick.
 */
export function sumGroupTries(items: readonly GroupableEntry[]): number {
  return items.reduce((total, item) => total + displayedAttemptCount(item.attemptCount), 0);
}
