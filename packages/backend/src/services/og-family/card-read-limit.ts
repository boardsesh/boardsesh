import { createSemaphore } from '@boardsesh/board-render';

/**
 * One expensive card read at a time per process. The backend's pool is 5
 * connections (`DB_POOL_MAX`'s default; the 10 in the docs is the web service),
 * and a single cold `userProfileStats` runs one transaction per board type, nine
 * in all, so one read can already occupy the whole pool. A second one alongside
 * it would only queue behind it and hold up every other request on the pool.
 */
const CARD_READ_CONCURRENCY = 1;
/**
 * About three seconds of waiting at roughly 300ms a read, inside what a chat
 * unfurler will sit through. Past that, a 503 costs less than a queue.
 */
const MAX_QUEUED_CARD_READS = 8;

const cardReads = createSemaphore(CARD_READ_CONCURRENCY);

/** Too many cold card reads are already waiting. Answered with a 503 and `Retry-After`. */
export class CardReadsSaturatedError extends Error {
  constructor() {
    super('Card reads are saturated');
    this.name = 'CardReadsSaturatedError';
  }
}

/**
 * Run a cache-miss read under the process-wide cap. Cache hits never come here,
 * so a card that is already held costs nothing and is never shed.
 */
export function runCardRead<T>(read: () => Promise<T>): Promise<T> {
  if (cardReads.pending >= MAX_QUEUED_CARD_READS) return Promise.reject(new CardReadsSaturatedError());
  return cardReads.run(read);
}

/**
 * Photo fetches and decodes have their own small cap. They wait on a CDN rather
 * than the database, so inside the slot above a brownout would stall every other
 * family card. Two at a time: a stalled host costs its timeout, not the route.
 */
const PHOTO_READ_CONCURRENCY = 2;
const MAX_QUEUED_PHOTO_READS = 4;

const photoReads = createSemaphore(PHOTO_READ_CONCURRENCY);

/** Run a photo fetch and decode under its own cap, shedding with the same 503 as a card read. */
export function runPhotoRead<T>(read: () => Promise<T>): Promise<T> {
  if (photoReads.pending >= MAX_QUEUED_PHOTO_READS) return Promise.reject(new CardReadsSaturatedError());
  return photoReads.run(read);
}
