import type { TFunction } from 'i18next';
import { getBoardCapabilities } from '@boardsesh/board-config';

/**
 * The climbs marked by `benchmark_difficulty` are called Verified on Kilter and
 * Benchmarks everywhere else (`BoardCapabilities.benchmarkTerm`). Only the word
 * changes: the filter flags, the column and the wire fields stay "benchmark" on
 * every board. An empty or unknown board keeps Benchmarks, which is what a
 * logbook spanning several boards wants.
 */
export function isVerifiedBoard(boardName: string | null | undefined): boolean {
  return getBoardCapabilities(boardName ?? undefined).benchmarkTerm === 'verified';
}

/** The Collection filter's name for these climbs on this board. */
export function benchmarkFilterLabel(boardName: string | null | undefined, t: TFunction<'climbs'>): string {
  return isVerifiedBoard(boardName) ? t('mobile.filter.verified') : t('mobile.filter.benchmark');
}

/**
 * What a screen reader says for a row's mark. "Verified climb" in full: a bare
 * "Verified" read just before the grade sounds like the grade is what was checked.
 */
export function benchmarkAttributeLabel(boardName: string | null | undefined, t: TFunction<'climbs'>): string {
  return isVerifiedBoard(boardName) ? t('mobile.climbRow.verified') : t('mobile.climbRow.benchmark');
}
