// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

const queue = vi.hoisted(() => ({
  state: { currentClimbQueueItem: null as ClimbQueueItem | null, queue: [] as ClimbQueueItem[] },
}));

const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));

// The accessory shows the wall's lit climb when a feed is live, else the local
// head — `useWallOrQueueCurrentClimb` mirrors that here so we can assert tap opens
// whatever the bar is showing.
const wall = vi.hoisted(() => ({ climb: null as Climb | null }));

// Capture the tap's onEnd worklet so a test can fire it like a real tap.
const tap = vi.hoisted(() => ({ onEnd: null as ((...args: unknown[]) => unknown) | null }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: queue.state }),
  useActiveClimbQueueItemUuid: () => queue.state.currentClimbQueueItem?.uuid ?? null,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));

vi.mock('../use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: Climb | null) => wall.climb ?? localClimb,
}));

vi.mock('../../../hooks/use-actively-climbing', () => ({ useIsActivelyClimbing: () => false }));
vi.mock('../../../lib/accessory-dismiss-store', () => ({ dismissAccessory: vi.fn() }));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('react-native-gesture-handler', () => {
  const tapBuilder = {
    maxDuration: () => tapBuilder,
    onEnd: (cb: (...args: unknown[]) => unknown) => {
      tap.onEnd = cb;
      return tapBuilder;
    },
  };
  const panBuilder = {
    enabled: () => panBuilder,
    activeOffsetY: () => panBuilder,
    failOffsetY: () => panBuilder,
    onEnd: () => panBuilder,
  };
  return {
    Gesture: {
      Tap: () => tapBuilder,
      Pan: () => panBuilder,
      Exclusive: (...gestures: unknown[]) => gestures[0],
    },
  };
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
    wall.climb = null;
    tap.onEnd = null;
  });

  it('exposes the local queue head as currentItem', () => {
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('head');
  });

  it('opens the local queue head active on tap (it already is current)', () => {
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.(undefined, true);
    // The bar shows the current climb, so it opens active — no preview.
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-head' }), {
      source: 'current_queue_item',
    });
  });

  it('opens a peer-driven wall climb as a preview when a board feed is live', () => {
    wall.climb = makeClimb('wall');
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.(undefined, true);
    // The wall climb isn't the local current, so it opens view-only (badged).
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-wall' }), {
      previewQueueItem: expect.objectContaining({ climb: expect.objectContaining({ uuid: 'climb-wall' }) }),
      source: 'current_queue_item',
    });
  });

  it('does nothing on tap when there is no climb to open', () => {
    queue.state.currentClimbQueueItem = null;
    wall.climb = null;
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.(undefined, true);
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });
});
