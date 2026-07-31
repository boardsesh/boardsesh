import { describe, expect, it } from 'vitest';
import type { boardseshTicks } from '@boardsesh/db/schema';

import { buildLogPushItem } from './push-back';

/**
 * pushPendingTicks (push-back.ts) builds a LogPushItem per pending tick
 * before handing off to Kilter's /api/logs/bulk. Kilter Grips ticks are
 * natively on a 1-5 quality scale (see catalog-sync.ts, quality-scale.ts,
 * user-sync.ts) — NOT Aurora's 1-3 scale. This guards against
 * convertQualityToAurora (an Aurora-scale-only helper) being reapplied
 * here, which would silently downscale every pushed tick's quality.
 *
 * The full push-back flow is gated behind KILTER_SYNC_PUSH_ENABLED and
 * bails via pushNotWired() before any HTTP call today, so this exercises
 * the item-construction logic directly rather than end-to-end.
 */
describe('buildLogPushItem', () => {
  function makeTick(overrides: Partial<typeof boardseshTicks.$inferSelect> = {}): typeof boardseshTicks.$inferSelect {
    return {
      id: BigInt(1),
      uuid: 'tick-uuid-1',
      userId: 'user-1',
      boardType: 'kilter',
      climbUuid: 'climb-uuid-1',
      angle: 40,
      isMirror: false,
      origin: 'native',
      status: 'send',
      attemptCount: 2,
      quality: 4,
      difficulty: null,
      isBenchmark: false,
      comment: '',
      climbedAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      sessionId: null,
      boardId: null,
      auroraType: null,
      auroraId: null,
      auroraSyncedAt: null,
      auroraSyncError: null,
      kilterType: null,
      kilterId: null,
      kilterSyncedAt: null,
      kilterSyncError: null,
      kilterDetachedAt: null,
      ...overrides,
    };
  }

  it('passes tick.quality through unconverted (raw 1-5 Grips scale)', () => {
    const tick = makeTick({ quality: 5 });
    const item = buildLogPushItem(tick, new Map());
    expect(item.quality).toBe(5);
  });

  it.each([1, 2, 3, 4, 5])('does not rescale quality=%d toward Aurora 1-3', (quality) => {
    const tick = makeTick({ quality });
    const item = buildLogPushItem(tick, new Map());
    expect(item.quality).toBe(quality);
  });

  it('maps a null quality (attempts) to undefined, not 0', () => {
    const tick = makeTick({ quality: null, status: 'attempt' });
    const item = buildLogPushItem(tick, new Map());
    expect(item.quality).toBeUndefined();
  });

  it('resolves climbUuid through the Kilter push-uuid alias map', () => {
    const tick = makeTick({ climbUuid: 'canonical-uuid' });
    const item = buildLogPushItem(tick, new Map([['canonical-uuid', 'kilter-alias-uuid']]));
    expect(item.climbUuid).toBe('kilter-alias-uuid');
  });

  it('falls back to the canonical climbUuid when the alias map has no entry', () => {
    const tick = makeTick({ climbUuid: 'canonical-uuid' });
    const item = buildLogPushItem(tick, new Map([['some-other-uuid', 'kilter-alias-uuid']]));
    expect(item.climbUuid).toBe('canonical-uuid');
  });
});
