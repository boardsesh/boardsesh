import type { LogbookFilterState, LogbookStatusSegment } from './types';

/** The status control's segments, in display order. */
export const LOGBOOK_STATUS_SEGMENTS: readonly LogbookStatusSegment[] = ['all', 'sends', 'flashes', 'attempts'];

type StatusFields = Pick<LogbookFilterState, 'includeSends' | 'includeAttempts' | 'flashOnly'>;

/**
 * The status fields with the impossible states repaired: with neither sends nor
 * attempts on, sends come back on (flash only kept), and flash only drops when
 * sends are off. The sanitizer, the segment reader and the feed input all go
 * through this, so an unsanitized in-memory state reads the same everywhere.
 */
export function repairLogbookStatus(filters: StatusFields): StatusFields {
  const includeSends = filters.includeSends || !filters.includeAttempts;
  return {
    includeSends,
    includeAttempts: filters.includeAttempts,
    flashOnly: includeSends ? filters.flashOnly : false,
  };
}

/**
 * Which status segment a stored filter reads as. Flash-only wins whenever sends
 * are in the set: the backend already treats "sends + attempts + flash only" as
 * flashes only, so an old stored `{both, flashOnly}` shows as Flashes. Flash-only
 * without sends is meaningless (the feed input drops it), so attempts-only reads
 * as Attempts whatever `flashOnly` says. Neither half on reads as the sanitizer
 * repairs it: Sends, or Flashes with flash only.
 */
export function statusSegmentFor(filters: StatusFields): LogbookStatusSegment {
  const status = repairLogbookStatus(filters);
  if (status.flashOnly) return 'flashes';
  if (status.includeSends && status.includeAttempts) return 'all';
  if (status.includeSends) return 'sends';
  return 'attempts';
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
