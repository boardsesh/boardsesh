// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ local: false, pick: false }));

vi.mock('../../providers/queue-provider', () => ({
  useHasActiveClimb: () => cfg.local,
}));
vi.mock('../../lib/last-pick-store', () => ({
  useHasLastPick: () => cfg.pick,
}));

import { useHasAccessoryClimb } from '../use-has-accessory-climb';

describe('useHasAccessoryClimb', () => {
  beforeEach(() => {
    cfg.local = false;
    cfg.pick = false;
  });

  // Owner decision A: a preview opened on an empty queue keeps a bar.
  it('is true for the climber’s last pick with no queue climb', () => {
    cfg.pick = true;
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(true);
  });

  it('is false when there is no local queue climb', () => {
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(false);
  });

  it('is true when a local queue climb is present', () => {
    cfg.local = true;
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(true);
  });
});
