import type { LogbookFilterState, LogbookStatusSegment } from './types';

/** The status control's segments, in display order. */
export const LOGBOOK_STATUS_SEGMENTS: readonly LogbookStatusSegment[] = ['all', 'sends', 'flashes', 'attempts'];

type StatusFields = Pick<LogbookFilterState, 'includeSends' | 'includeAttempts' | 'flashOnly'>;

/**
 * Which status segment a stored filter reads as. Flash-only wins whenever sends
 * are in the set: the backend already treats "sends + attempts + flash only" as
 * flashes only, so an old stored `{both, flashOnly}` shows as Flashes. Flash-only
 * without sends is meaningless (the feed input drops it), so attempts-only reads
 * as Attempts whatever `flashOnly` says.
 */
export function statusSegmentFor(filters: StatusFields): LogbookStatusSegment {
  if (filters.includeSends && filters.flashOnly) return 'flashes';
  if (filters.includeSends && filters.includeAttempts) return 'all';
  if (filters.includeSends) return 'sends';
  if (filters.includeAttempts) return 'attempts';
  // Neither half on: the sanitizer never stores this, so read it as the default.
  return 'all';
}

/** The stored status fields a segment writes. Flashes = sends only + flash only. */
export function filtersForStatusSegment(segment: LogbookStatusSegment): StatusFields {
  switch (segment) {
    case 'sends':
      return { includeSends: true, includeAttempts: false, flashOnly: false };
    case 'flashes':
      return { includeSends: true, includeAttempts: false, flashOnly: true };
    case 'attempts':
      return { includeSends: false, includeAttempts: true, flashOnly: false };
    case 'all':
    default:
      return { includeSends: true, includeAttempts: true, flashOnly: false };
  }
}
