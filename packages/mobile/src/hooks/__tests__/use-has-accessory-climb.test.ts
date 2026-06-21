// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ local: false, wall: false }));

vi.mock('../../providers/queue-provider', () => ({
  useHasActiveClimb: () => cfg.local,
}));
vi.mock('../../components/queue-control/use-wall-or-queue-climb', () => ({
  useHasWallClimb: () => cfg.wall,
}));

import { useHasAccessoryClimb } from '../use-has-accessory-climb';

describe('useHasAccessoryClimb', () => {
  beforeEach(() => {
    cfg.local = false;
    cfg.wall = false;
  });

  it('is false when neither a local nor a wall climb is present', () => {
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(false);
  });

  it('is true for a local-only climb', () => {
    cfg.local = true;
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(true);
  });

  it('is true for a wall-only climb (no local queue)', () => {
    cfg.wall = true;
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(true);
  });

  it('is true when both a local and a wall climb are present', () => {
    cfg.local = true;
    cfg.wall = true;
    const { result } = renderHook(() => useHasAccessoryClimb());
    expect(result.current).toBe(true);
  });
});
