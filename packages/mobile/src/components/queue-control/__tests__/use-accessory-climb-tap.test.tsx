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
  useQueueData: () => queue.state,
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
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';
import type { PlaylistSuggestionSource } from '@boardsesh/queue';

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
    resetLastPickForTests();
  });

  it('exposes the local queue head as currentItem', () => {
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('head');
  });

  it('opens the local queue head active on tap (it already is current — never the wall climb)', () => {
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.();
    // A reopen, not a pick: a #4979 hold on the head stays standing.
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-head' }), {
      reopensCurrent: true,
    });
  });

  it('does nothing on tap when there is no queue head to open', () => {
    queue.state.currentClimbQueueItem = null;
    renderHook(() => useAccessoryClimbTap());
    tap.onEnd?.();
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });

  it('stages the queue head without competing with Link navigation', () => {
    const { result } = renderHook(() => useAccessoryClimbTap());
    result.current.preparePlay();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-head' }), {
      navigate: false,
      reopensCurrent: true,
    });
  });
});

// Owner decision A: the bar shows the climber's last pick (a preview
// included) or the queue's current climb when THAT changed after it, and a tap
// reopens the pick as the same preview with its list, not the committed head.
describe('useAccessoryClimbTap with a last pick', () => {
  const track: PlaylistSuggestionSource = {
    playlistUuid: 'playlist',
    activatedClimbUuid: 'climb-pick',
    boardKey: 'kilter:1',
    climbs: [makeClimb('pick'), makeClimb('after')],
  };
  const commitOptions = { placement: 'STEP' as const };

  function pickUnderHead(over: { mirrored?: boolean } = {}) {
    const item = makeItem('pick');
    setLastPick({
      item,
      suggestionSource: track,
      commitOptions,
      mirrored: over.mirrored ?? false,
      currentAtPick: 'head',
      wallAtPick: 'climb-wall',
      pickedAt: 42,
    });
    return item;
  }

  beforeEach(() => {
    drawer.openPlayDrawer.mockClear();
    queue.state.currentClimbQueueItem = makeItem('head');
    queue.state.queue = [queue.state.currentClimbQueueItem];
    tap.onEnd = null;
    resetLastPickForTests();
  });

  it('shows the pick made after the current climb, and reopens it as the same preview with its track', () => {
    const item = pickUnderHead({ mirrored: true });
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('pick');
    tap.onEnd?.();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(item.climb, {
      previewQueueItem: item,
      playlistSuggestionSource: track,
      previewCommitOptions: commitOptions,
      previewMirrored: true,
      previewLatchStart: { wallClimbUuid: 'climb-wall', at: 42 },
    });
  });

  it('stages the pick the same way for a Link', () => {
    const item = pickUnderHead();
    const { result } = renderHook(() => useAccessoryClimbTap());
    result.current.preparePlay();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      item.climb,
      expect.objectContaining({ previewQueueItem: item, playlistSuggestionSource: track, navigate: false }),
    );
  });

  it('shows the queue’s current once it changed after the pick', () => {
    pickUnderHead();
    queue.state.currentClimbQueueItem = makeItem('crewmate');
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('crewmate');
    expect(result.current.pick).toBeNull();
    tap.onEnd?.();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-crewmate' }), {
      reopensCurrent: true,
    });
  });

  it('shows the pick on an empty queue', () => {
    queue.state.currentClimbQueueItem = null;
    queue.state.queue = [];
    setLastPick({
      item: makeItem('pick'),
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: null,
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('pick');
  });

  it('drops a pick made under another account', () => {
    pickUnderHead();
    invalidateCredentialSnapshots();
    const { result } = renderHook(() => useAccessoryClimbTap());
    expect(result.current.currentItem?.uuid).toBe('head');
  });
});
