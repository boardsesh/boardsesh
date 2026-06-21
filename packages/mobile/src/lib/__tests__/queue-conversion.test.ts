import { describe, it, expect } from 'vitest';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../queue-conversion';

// A reconnect FullSync wholesale-replaces the queue (and currentClimbQueueItem)
// from the subscription payload. If toClimbQueueItem drops a field the
// subscription now selects, the field is lost on every server-driven update:
// a peer-set `mirrored` flag (read by the Bluetooth auto-sender) gets cleared
// and multi-frame playback falls back to DEFAULT_PACE_MS instead of the
// setter's framesPace. These round-trips pin the four SEED-2 fields.

function makeSubscriptionItem(overrides: Partial<SubscriptionQueueItem['climb']> = {}): SubscriptionQueueItem {
  return {
    uuid: 'qi-1',
    climb: {
      uuid: 'climb-1',
      name: 'Variable Speed Circuit',
      frames: 'p1r12p2r13',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 5,
      difficulty: '21',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.5',
      benchmark_difficulty: null,
      boardType: 'kilter',
      layoutId: 1,
      mirrored: true,
      is_no_match: true,
      framesCount: 4,
      framesPace: 1200,
      ...overrides,
    },
  };
}

describe('toClimbQueueItem (SEED-2 fields)', () => {
  it('carries mirrored, is_no_match, framesCount and framesPace through the conversion', () => {
    const result = toClimbQueueItem(makeSubscriptionItem());

    expect(result.climb.mirrored).toBe(true);
    expect(result.climb.is_no_match).toBe(true);
    expect(result.climb.framesCount).toBe(4);
    expect(result.climb.framesPace).toBe(1200);
  });

  it('preserves a peer-set mirror flag of false (not just truthy)', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ mirrored: false }));

    expect(result.climb.mirrored).toBe(false);
  });

  it('passes null/undefined frame metadata through unchanged', () => {
    const result = toClimbQueueItem(
      makeSubscriptionItem({ mirrored: null, is_no_match: null, framesCount: null, framesPace: null }),
    );

    expect(result.climb.mirrored).toBeNull();
    expect(result.climb.is_no_match).toBeNull();
    expect(result.climb.framesCount).toBeNull();
    expect(result.climb.framesPace).toBeNull();
  });

  it('carries boardType/layoutId so a peer-synced spill climb can be skipped on another board', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ boardType: 'tension', layoutId: 8 }));

    expect(result.climb.boardType).toBe('tension');
    expect(result.climb.layoutId).toBe(8);
  });

  it('leaves board metadata undefined when a pre-metadata peer omits it (treated as sendable)', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ boardType: undefined, layoutId: undefined }));

    expect(result.climb.boardType).toBeUndefined();
    // layoutId falls through as undefined; the spill guard reads nullish as "unknown".
    expect(result.climb.layoutId).toBeUndefined();
  });
});
