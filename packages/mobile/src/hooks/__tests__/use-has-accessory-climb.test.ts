// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ local: false }));

vi.mock('../../providers/queue-provider', () => ({
  useHasActiveClimb: () => cfg.local,
}));

import { useHasAccessoryClimb } from '../use-has-accessory-climb';
import { clearLastPick, resetLastPickForTests, setLastPick } from '../../lib/last-pick-store';

const PICK_ITEM = { uuid: 'queue-pick', climb: { uuid: 'pick', name: 'Pick' } } as unknown as ClimbQueueItem;

function pick(uuid = 'queue-pick') {
  setLastPick({
    item: { ...PICK_ITEM, uuid },
    suggestionSource: null,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick: null,
    wallAtPick: null,
    pickedAt: 0,
  });
}

describe('useHasAccessoryClimb', () => {
  beforeEach(() => {
    cfg.local = false;
    resetLastPickForTests();
  });

  // Owner decision A: a preview opened on an empty queue keeps a bar.
  it('is true for the climber’s last pick with no queue climb', () => {
    pick();
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

  // PERF: TabLayout renders the whole NativeTabs tree inline, so it re-renders
  // only when the answer flips, never on a preview opening or ending under a
  // queue climb.
  it('does not re-render while a queue climb holds the answer and a pick comes and goes', () => {
    cfg.local = true;
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useHasAccessoryClimb();
    });
    const before = renders;
    act(() => pick());
    act(() => pick('queue-other'));
    act(() => clearLastPick());
    expect(renders).toBe(before);
  });

  it('flips with the pick on an empty queue', () => {
    const { result } = renderHook(() => useHasAccessoryClimb());
    act(() => pick());
    expect(result.current).toBe(true);
    act(() => clearLastPick());
    expect(result.current).toBe(false);
  });
});
