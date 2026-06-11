// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted provider/nav spies so each test drives party-preview gating + the
// suggestion-aware navigation result the carousel reads.
const queue = vi.hoisted(() => ({
  state: {
    currentClimbQueueItem: null as ClimbQueueItem | null,
    queue: [] as ClimbQueueItem[],
  },
  sessionId: null as string | null,
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  isPartyPreviewOnly: false,
}));

const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
const route = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));

const nav = vi.hoisted(() => ({
  result: {
    canNext: false,
    canPrevious: false,
    nextItem: null as ClimbQueueItem | null,
    prevItem: null as ClimbQueueItem | null,
    remainingCount: 0,
  },
}));

// Capture the options useCarouselGesture is called with so we can assert the
// gated canSwipeNext/canSwipePrevious flags fed into the pan gesture.
const gestureCalls = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: queue.state, nextClimb: queue.nextClimb, previousClimb: queue.previousClimb }),
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  usePlaylistSuggestionSource: () => null,
  useIsPartyPreviewOnly: () => queue.isPartyPreviewOnly,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useSegments: () => route.segments,
}));

vi.mock('@boardsesh/play-view', () => ({
  computePeekOffset: () => 0,
  computeNavigationStateWithSuggestions: () => nav.result,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('react-native', () => ({}));

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const builder = new Proxy(chainable, { get: () => () => builder });
  return { Gesture: { Tap: () => builder, Pan: () => builder, Race: () => builder } };
});

vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
  useSharedValue: (initial: number) => ({ value: initial }),
}));

vi.mock('../../play-drawer/use-carousel-gesture', () => ({
  useCarouselGesture: (options: Record<string, unknown>) => {
    gestureCalls.last = options;
    return { gesture: {}, translateX: { value: 0 } };
  },
}));

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticSelection: vi.fn() }));

import { useQueueCarousel } from '../use-queue-carousel';

function makeItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
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
    },
  };
}

describe('useQueueCarousel party-preview gating', () => {
  beforeEach(() => {
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    queue.sessionId = null;
    queue.isPartyPreviewOnly = false;
    drawer.openPlayDrawer.mockClear();
    router.navigate.mockClear();
    route.segments = ['(tabs)', 'climbs'];
    gestureCalls.last = null;
    const current = makeItem('current');
    const next = makeItem('next');
    queue.state.currentClimbQueueItem = current;
    queue.state.queue = [current, next];
    nav.result = { canNext: true, canPrevious: true, nextItem: next, prevItem: current, remainingCount: 1 };
  });

  it('drives the shared current climb when the user IS the driver (not preview-only)', () => {
    const { result } = renderHook(() => useQueueCarousel());

    result.current.handleNext();
    result.current.handlePrevious();

    // Driver: both stepping callbacks mutate the shared session.
    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
    expect(result.current.canNext).toBe(true);
    expect(result.current.canPrevious).toBe(true);
    expect(result.current.swipeAccessibilityActions.map((action) => action.name)).toEqual(['previous', 'next']);
  });

  it('does NOT mutate the shared current climb when party preview-only (gesture path)', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueCarousel());

    result.current.handleNext();
    result.current.handlePrevious();

    // Non-driver: the bar swipe must not call into the session mutation path.
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(queue.previousClimb).not.toHaveBeenCalled();
  });

  it('disables swipe + a11y prev/next for a preview-only member', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueCarousel());

    // The exported flags that gate the swipe and the VoiceOver actions are off,
    // even though the underlying navigation reports next/previous are available.
    expect(result.current.canNext).toBe(false);
    expect(result.current.canPrevious).toBe(false);
    expect(result.current.swipeAccessibilityActions).toEqual([]);
  });

  it('passes the gated swipe flags into the pan gesture (RNGH cannot commit a step)', () => {
    queue.isPartyPreviewOnly = true;
    renderHook(() => useQueueCarousel());

    expect(gestureCalls.last?.canSwipeNext).toBe(false);
    expect(gestureCalls.last?.canSwipePrevious).toBe(false);
  });

  it('still surfaces the peek labels so a non-driver can SEE the next climb', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueCarousel());

    // Preview, not blackout: the next/previous peek items still render.
    expect(result.current.nextItem?.uuid).toBe('next');
    expect(result.current.previousItem?.uuid).toBe('current');
  });

  it('returns to the Record tab on primary tap during an active session outside Record', () => {
    queue.sessionId = 'session-1';
    const { result } = renderHook(() => useQueueCarousel());

    result.current.handlePrimaryPress();

    expect(router.navigate).toHaveBeenCalledWith('/(tabs)/record');
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
    expect(result.current.returnToSessionAvailable).toBe(true);
    expect(result.current.swipeAccessibilityActions.map((action) => action.name)).toContain('returnToSession');
  });

  it('keeps primary tap on the play drawer when no session is active', () => {
    const { result } = renderHook(() => useQueueCarousel());

    result.current.handlePrimaryPress();

    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(queue.state.currentClimbQueueItem?.climb, {
      setAsCurrent: false,
    });
    expect(router.navigate).not.toHaveBeenCalled();
    expect(result.current.returnToSessionAvailable).toBe(false);
  });

  it('keeps primary tap on the play drawer when already on the Record tab', () => {
    queue.sessionId = 'session-1';
    route.segments = ['(tabs)', 'record'];
    const { result } = renderHook(() => useQueueCarousel());

    result.current.handlePrimaryPress();

    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(queue.state.currentClimbQueueItem?.climb, {
      setAsCurrent: false,
    });
    expect(router.navigate).not.toHaveBeenCalled();
    expect(result.current.returnToSessionAvailable).toBe(false);
  });
});
