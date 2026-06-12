// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted provider/nav spies so each test drives party-preview gating + the
// suggestion-aware navigation result the carousel reads.
const queue = vi.hoisted(() => ({
  state: {
    currentClimbQueueItem: null as ClimbQueueItem | null,
    queue: [] as ClimbQueueItem[],
  },
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  isPartyPreviewOnly: false,
}));

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
  usePlaylistSuggestionSource: () => null,
  useIsPartyPreviewOnly: () => queue.isPartyPreviewOnly,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn() }),
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

import { useQueueClimbCarousel } from '../use-queue-climb-carousel';

type AccessibilityActionHandler = ReturnType<typeof useQueueClimbCarousel>['onAccessibilityAction'];

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

function makeAccessibilityAction(actionName: string): Parameters<AccessibilityActionHandler>[0] {
  return { nativeEvent: { actionName } } as Parameters<AccessibilityActionHandler>[0];
}

describe('useQueueClimbCarousel party-preview gating', () => {
  beforeEach(() => {
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    queue.isPartyPreviewOnly = false;
    gestureCalls.last = null;
    const current = makeItem('current');
    const next = makeItem('next');
    queue.state.currentClimbQueueItem = current;
    queue.state.queue = [current, next];
    nav.result = { canNext: true, canPrevious: true, nextItem: next, prevItem: current, remainingCount: 1 };
  });

  it('drives the shared current climb when the user IS the driver (not preview-only)', () => {
    const { result } = renderHook(() => useQueueClimbCarousel());

    result.current.handleNext();
    result.current.handlePrevious();

    // Driver: both stepping callbacks mutate the shared session.
    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
    expect(result.current.canNext).toBe(true);
    expect(result.current.canPrevious).toBe(true);
    expect(result.current.swipeAccessibilityActions.map((action) => action.name)).toEqual(['previous', 'next']);
  });

  it('routes VoiceOver prev/next actions through the shared step handlers', () => {
    const { result } = renderHook(() => useQueueClimbCarousel());

    result.current.onAccessibilityAction(makeAccessibilityAction('next'));
    result.current.onAccessibilityAction(makeAccessibilityAction('previous'));

    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
  });

  it('does NOT mutate the shared current climb when party preview-only (gesture path)', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueClimbCarousel());

    result.current.handleNext();
    result.current.handlePrevious();
    result.current.onAccessibilityAction(makeAccessibilityAction('next'));
    result.current.onAccessibilityAction(makeAccessibilityAction('previous'));

    // Non-driver: neither the bar swipe nor the a11y actions can call into the
    // shared-session mutation path.
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(queue.previousClimb).not.toHaveBeenCalled();
  });

  it('disables swipe + a11y prev/next for a preview-only member', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueClimbCarousel());

    // The exported flags that gate the swipe and the VoiceOver actions are off,
    // even though the underlying navigation reports next/previous are available.
    expect(result.current.canNext).toBe(false);
    expect(result.current.canPrevious).toBe(false);
    expect(result.current.swipeAccessibilityActions).toEqual([]);
  });

  it('passes the gated swipe flags into the pan gesture (RNGH cannot commit a step)', () => {
    queue.isPartyPreviewOnly = true;
    renderHook(() => useQueueClimbCarousel());

    expect(gestureCalls.last?.canSwipeNext).toBe(false);
    expect(gestureCalls.last?.canSwipePrevious).toBe(false);
  });

  it('accepts explicit viewport width and reduce-motion overrides', () => {
    const { result } = renderHook(() => useQueueClimbCarousel(320, true));

    expect(result.current.canPeek).toBe(true);
    expect(gestureCalls.last?.boardWidth).toBe(320);
    expect(gestureCalls.last?.enabled).toBe(true);
    expect(gestureCalls.last?.reduceMotion).toBe(true);

    // A layout event with a conflicting width must not override the configured value.
    act(() => {
      result.current.onLayout({ nativeEvent: { layout: { width: 0 } } } as LayoutChangeEvent);
    });

    expect(result.current.canPeek).toBe(true); // configuredWidth=320 still in effect
    expect(gestureCalls.last?.boardWidth).toBe(320); // widthSV not overwritten to 0
  });

  it('still surfaces the peek labels so a non-driver can SEE the next climb', () => {
    queue.isPartyPreviewOnly = true;
    const { result } = renderHook(() => useQueueClimbCarousel());

    // Preview, not blackout: the next/previous peek items still render.
    expect(result.current.nextItem?.uuid).toBe('next');
    expect(result.current.previousItem?.uuid).toBe('current');
  });
});
