// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

const queue = vi.hoisted(() => ({
  state: { currentClimbQueueItem: null as ClimbQueueItem | null, queue: [] as ClimbQueueItem[] },
}));

const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));

// Capture the tap's onEnd worklet so a test can fire it like a real tap.
const tap = vi.hoisted(() => ({ onEnd: null as ((...args: unknown[]) => unknown) | null }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: queue.state }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('react-native-gesture-handler', () => {
  const builder = {
    maxDuration: () => builder,
    onEnd: (cb: (...args: unknown[]) => unknown) => {
      tap.onEnd = cb;
      return builder;
    },
  };
  return { Gesture: { Tap: () => builder } };
});

import { useAccessoryClimbTap } from '../use-accessory-climb-tap';

function makeClimb(uuid: string): Climb {
  return {
    uuid: `climb-${uuid}`,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  };
}

function makeItem(uuid: string): ClimbQueueItem {
  return { uuid, climb: makeClimb(uuid) };
}

describe('useAccessoryClimbTap', () => {
  beforeEach(() => {
    drawer.openPlayDrawer.mockClear();
    queue.state.currentClimbQueueItem = makeItem('head');
    queue.state.queue = [queue.state.currentClimbQueueItem];
    tap.onEnd = null;
  });

  it('exposes the local queue head as currentItem', () => {
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('head');
  });

  it('opens the local queue head active on tap (it already is current — never the wall climb)', () => {
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-head' }), {});
  });

  it('does nothing on tap when there is no queue head to open', () => {
    queue.state.currentClimbQueueItem = null;
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.();
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });
});
