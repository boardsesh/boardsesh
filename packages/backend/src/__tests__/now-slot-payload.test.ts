import { describe, it, expect } from 'vite-plus/test';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { MAX_SYNCED_QUEUE_ITEMS, QUEUE_FULL } from '@boardsesh/queue';
import { GraphQLError } from 'graphql';
import {
  MAX_RAW_PAYLOAD_ITEMS,
  UpNextOverCapError,
  composeQueuePayload,
  maxPayloadItems,
} from '../graphql/resolvers/queue/now-slot-payload';

function wallItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: `climb-${uuid}`, name: uuid, angle: 40 },
    addedBy: 'participant-1',
    suggested: false,
  } as ClimbQueueItem;
}

const itemsNamed = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => wallItem(`${prefix}${index}`));

function composeError(compose: () => unknown): unknown {
  try {
    compose();
  } catch (error) {
    return error;
  }
  return null;
}

describe('composeQueuePayload caps (docs/current-climb-outside-queue.md, section 5)', () => {
  it('rejects a 600-climb Up next with nothing current instead of dropping its first climbs', () => {
    const playlist = itemsNamed('p', 600);
    const error = composeError(() =>
      composeQueuePayload({
        queue: playlist,
        currentClimbQueueItem: null,
        historyCountInput: 0,
        stored: null,
        capsApply: true,
      }),
    );
    expect(error).toBeInstanceOf(UpNextOverCapError);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe(QUEUE_FULL);
  });

  it('trims History, not Up next, when nothing is current and the payload is over 500', () => {
    const history = itemsNamed('h', 150);
    const upNext = itemsNamed('u', 400);
    const composed = composeQueuePayload({
      queue: [...history, ...upNext],
      currentClimbQueueItem: null,
      historyCountInput: 150,
      stored: null,
      capsApply: true,
    });
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(composed.historyCount).toBe(100);
    // The first climb the crew would climb next survives.
    expect(composed.queue[composed.historyCount].uuid).toBe('u0');
    expect(composed.queue.at(-1)?.uuid).toBe('u399');
  });

  it('stores Now + 500 Up next (501 entries): the climb on the wall is extra', () => {
    const current = wallItem('now');
    const composed = composeQueuePayload({
      queue: [current, ...itemsNamed('u', MAX_SYNCED_QUEUE_ITEMS)],
      currentClimbQueueItem: current,
      historyCountInput: null,
      stored: null,
      capsApply: true,
    });
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(composed.trimmedCount).toBe(0);
  });

  it('rejects with QUEUE_FULL when a climb is current and Up next alone exceeds 500', () => {
    const current = wallItem('now');
    const error = composeError(() =>
      composeQueuePayload({
        queue: [current, ...itemsNamed('u', MAX_SYNCED_QUEUE_ITEMS + 1)],
        currentClimbQueueItem: current,
        historyCountInput: null,
        stored: null,
        capsApply: true,
      }),
    );
    expect((error as GraphQLError).extensions.code).toBe(QUEUE_FULL);
    expect((error as GraphQLError).message).toMatch(/Up next holds 501/);
  });

  it('trims History to 500 History + Up next with a climb current, keeping 501 entries', () => {
    const history = itemsNamed('h', 5);
    const current = wallItem('now');
    const composed = composeQueuePayload({
      queue: [...history, current, ...itemsNamed('u', MAX_SYNCED_QUEUE_ITEMS - 2)],
      currentClimbQueueItem: current,
      historyCountInput: null,
      stored: null,
      capsApply: true,
    });
    // 5 + 1 + 498 = 504 entries, 503 counted: three History entries go.
    expect(composed.trimmedCount).toBe(3);
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(composed.queue[0].uuid).toBe('h3');
  });

  it('outside the caps, an orphan inserted into a 500-item payload is the extra Now entry, nothing trimmed', () => {
    const history = itemsNamed('h', 10);
    const upNext = itemsNamed('u', MAX_SYNCED_QUEUE_ITEMS - 10);
    const orphan = wallItem('orphan');
    const composed = composeQueuePayload({
      queue: [...history, ...upNext],
      currentClimbQueueItem: orphan,
      historyCountInput: null,
      stored: { queue: history, currentClimbQueueItem: null, historyCount: 10 },
      capsApply: false,
    });
    expect(composed.orphanInserted).toBe(true);
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(composed.trimmedCount).toBe(0);
    expect(composed.queue[0].uuid).toBe('h0');
    expect(composed.historyCount).toBe(10);
    expect(composed.queue[composed.historyCount].uuid).toBe('orphan');
  });

  it('outside the caps, merge survivors past 500 History + Up next trim History, with the climb on the wall extra', () => {
    const history = itemsNamed('h', 3);
    const current = wallItem('now');
    const composed = composeQueuePayload({
      queue: [...history, current, ...itemsNamed('u', MAX_SYNCED_QUEUE_ITEMS - 1)],
      currentClimbQueueItem: current,
      historyCountInput: null,
      stored: null,
      capsApply: false,
    });
    // 3 + 1 + 499 = 503 entries, 502 counted: two History entries go.
    expect(composed.trimmedCount).toBe(2);
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
  });

  it('outside the caps, a payload at or under 500 is stored as sent', () => {
    const history = itemsNamed('h', 200);
    const composed = composeQueuePayload({
      queue: history,
      currentClimbQueueItem: null,
      historyCountInput: null,
      stored: { queue: history, currentClimbQueueItem: null, historyCount: 200 },
      capsApply: false,
    });
    expect(composed.queue).toHaveLength(200);
    expect(composed.trimmedCount).toBe(0);
    expect(composed.historyCount).toBe(200);
  });
});

describe('maxPayloadItems (the raw guard, section 5)', () => {
  const current = wallItem('now');
  const raw = itemsNamed('u', 3);

  it('is the 1,000-item memory guard when the caps apply', () => {
    expect(maxPayloadItems(raw, null, true)).toBe(MAX_RAW_PAYLOAD_ITEMS);
  });

  it('is 501 outside the caps when the current climb is in the payload queue', () => {
    expect(maxPayloadItems([...raw, current], current, false)).toBe(MAX_SYNCED_QUEUE_ITEMS + 1);
  });

  it('is 500 outside the caps with nothing current, or a current climb not in the queue', () => {
    expect(maxPayloadItems(raw, null, false)).toBe(MAX_SYNCED_QUEUE_ITEMS);
    expect(maxPayloadItems(raw, current, false)).toBe(MAX_SYNCED_QUEUE_ITEMS);
    expect(maxPayloadItems('not an array', current, false)).toBe(MAX_SYNCED_QUEUE_ITEMS);
    expect(maxPayloadItems([null, 7, { uuid: 3 }], { uuid: 3 }, false)).toBe(MAX_SYNCED_QUEUE_ITEMS);
  });
});
