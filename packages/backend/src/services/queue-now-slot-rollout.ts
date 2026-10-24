import { logger } from '../utils/logger';

/**
 * `QUEUE_NOW_SLOT_PERCENT`: the backend kill switch for F3 (#6666,
 * docs/current-climb-outside-queue.md, section 8).
 *
 * A session is in when the FNV-1a hash of its id mod 100 is below the percent.
 * Unset, blank or unparseable means 0, so it fails closed to today's rules.
 *
 * It gates only what requests WITHOUT `placement` get (shipped clients, the
 * native socket, the LED path, every `addQueueItem` and `reorderQueueItem`):
 * the placement rules, the History clamps, the stop-at-the-ends navigate and
 * the caps. The `historyCount` bookkeeping and the orphan rules run at every
 * percent, and a request carrying `placement` (or a `setQueue` carrying
 * `historyCount`) gets the new rules whatever the percent says.
 */
export const QUEUE_NOW_SLOT_PERCENT_ENV = 'QUEUE_NOW_SLOT_PERCENT';

/**
 * Parse the percent the way `readCap` (`websocket/connection-cap.ts`) parses
 * its caps: blank means the default (0), an invalid value is logged and
 * ignored, and the result is clamped to 0-100.
 */
export function parseNowSlotPercent(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) {
    logger.warn(`[queue-now-slot] Ignoring invalid ${QUEUE_NOW_SLOT_PERCENT_ENV}; falling back to 0`, { value: raw });
    return 0;
  }
  return Math.min(Math.max(parsed, 0), 100);
}

/** 32-bit FNV-1a over the UTF-16 code units of `text`. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The session's fixed bucket, 0-99. */
export function nowSlotBucket(sessionId: string): number {
  return fnv1a32(sessionId) % 100;
}

/**
 * Whether placement-less requests in this session get the F3 rules. The env
 * is read on every call: a Railway variable change redeploys the service, so
 * there is nothing to cache, and tests can flip it per case.
 */
export function isNowSlotSession(sessionId: string): boolean {
  const percent = parseNowSlotPercent(process.env[QUEUE_NOW_SLOT_PERCENT_ENV]);
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return nowSlotBucket(sessionId) < percent;
}
