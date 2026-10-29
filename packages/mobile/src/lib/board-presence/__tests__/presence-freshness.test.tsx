// @vitest-environment jsdom
// QA #147: board presence's wall climb is trusted for an hour without a link.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENCE_FRESH_MS,
  isPresenceFresh,
  isWallPresenceTrusted,
  trustedWallCapsuleClimb,
  usePresenceFresh,
} from '../presence-freshness';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

const LIT_AT = Date.parse('2026-10-29T12:00:00.000Z');
const minutes = (count: number) => LIT_AT + count * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('isPresenceFresh', () => {
  it('is fresh at 59 minutes and stale at 61', () => {
    const sentAt = new Date(LIT_AT).toISOString();
    expect(isPresenceFresh(sentAt, minutes(59))).toBe(true);
    expect(isPresenceFresh(sentAt, minutes(61))).toBe(false);
    expect(PRESENCE_FRESH_MS).toBe(60 * 60_000);
  });

  it('is never fresh with no stamp, or one it cannot read', () => {
    expect(isPresenceFresh(null, minutes(1))).toBe(false);
    expect(isPresenceFresh('not a date', minutes(1))).toBe(false);
  });

  it('is trusted with a live link whatever its age', () => {
    expect(isWallPresenceTrusted({ linked: true, presenceFresh: false })).toBe(true);
    expect(isWallPresenceTrusted({ linked: false, presenceFresh: true })).toBe(true);
    expect(isWallPresenceTrusted({ linked: false, presenceFresh: false })).toBe(false);
  });
});

describe('usePresenceFresh (frozen clock)', () => {
  it('turns stale on its own when the hour runs out, with no polling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(minutes(59));
    const { result } = renderHook(() => usePresenceFresh(new Date(LIT_AT).toISOString()));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is stale at once at 61 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(minutes(61));
    expect(renderHook(() => usePresenceFresh(new Date(LIT_AT).toISOString())).result.current).toBe(false);
  });
});

// #7095: the Climbs header's wall capsule hides past the hour with no live link.
describe('trustedWallCapsuleClimb', () => {
  const climb = { climbUuid: 'the-eyes', sentAt: new Date(LIT_AT).toISOString(), seq: 1 } as BoardPresenceClimb;

  it.each([
    ['fresh, no link', { linked: false, presenceFresh: true }, true],
    ['stale, no link', { linked: false, presenceFresh: false }, false],
    ['stale, a live link', { linked: true, presenceFresh: false }, true],
  ] as const)('%s', (_case, trust, shown) => {
    expect(trustedWallCapsuleClimb(climb, trust)).toBe(shown ? climb : null);
  });

  it('has nothing to show with no wall climb', () => {
    expect(trustedWallCapsuleClimb(null, { linked: true, presenceFresh: true })).toBeNull();
  });
});
