import { describe, it, expect } from 'vite-plus/test';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { MAX_SYNCED_QUEUE_ITEMS, QUEUE_FULL } from '@boardsesh/queue';
import { GraphQLError } from 'graphql';
import { UpNextOverCapError, composeQueuePayload } from '../graphql/resolvers/queue/now-slot-payload';

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

  it('rejects with QUEUE_FULL when a climb is current and Now + Up next exceed 500', () => {
    const current = wallItem('now');
    const error = composeError(() =>
      composeQueuePayload({
        queue: [current, ...itemsNamed('u', 500)],
        currentClimbQueueItem: current,
        historyCountInput: null,
        stored: null,
        capsApply: true,
      }),
    );
    expect((error as GraphQLError).extensions.code).toBe(QUEUE_FULL);
  });

  it('outside the caps, an orphan inserted into a 500-item payload trims the oldest History entry', () => {
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
    expect(composed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(composed.trimmedCount).toBe(1);
    expect(composed.queue[0].uuid).toBe('h1');
    expect(composed.historyCount).toBe(9);
    expect(composed.queue[composed.historyCount].uuid).toBe('orphan');
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
