// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

const spies = vi.hoisted(() => ({ track: vi.fn(), openLogAscent: vi.fn() }));

vi.mock('react-native-reanimated', () => ({
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSequence: (...args: number[]) => args[args.length - 1],
  withSpring: (value: number) => value,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => null,
  useOptionalBoardActions: () => null,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111111' }, brandColors: { success: '#34C759' } }),
}));
const session = vi.hoisted(() => ({
  sessionId: null as string | null,
  currentClimbQueueItem: null as ClimbQueueItem | null,
  queue: [] as ClimbQueueItem[],
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: session.sessionId }),
  useQueueActions: () => ({ getQueueSnapshot: () => session }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openLogAscent: spies.openLogAscent,
    boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
  }),
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../theme/animations', () => ({ springs: { bouncy: {}, snappy: {} } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));

import { useLogAscentAction } from '../use-log-ascent-action';

const climb = { uuid: 'climb-1', name: 'Test', frames: '', angle: 40 } as Climb;

describe('useLogAscentAction Quick Tick Opened', () => {
  beforeEach(() => spies.track.mockClear());

  it('tags the platter tick with its placement', () => {
    const { result } = renderHook(() => useLogAscentAction(climb, 'inline'));
    act(() => result.current.handleLogAscentPress());
    expect(spies.track).toHaveBeenCalledWith('Quick Tick Opened', {
      climbUuid: 'climb-1',
      layoutId: 1,
      source: 'queue_bar',
      placement: 'inline',
    });
  });

  it('sends no placement from the JS bars that share the source', () => {
    const { result } = renderHook(() => useLogAscentAction(climb));
    act(() => result.current.handleLogAscentPress());
    expect(spies.track).toHaveBeenCalledWith('Quick Tick Opened', {
      climbUuid: 'climb-1',
      layoutId: 1,
      source: 'queue_bar',
    });
  });
});

describe('useLogAscentAction orientation', () => {
  beforeEach(() => {
    spies.openLogAscent.mockClear();
    session.sessionId = null;
    session.currentClimbQueueItem = null;
    session.queue = [];
  });

  const openedMirror = () => spies.openLogAscent.mock.calls.at(-1)?.[0].isMirror;

  it("logs the climb's own orientation when nobody flipped it", () => {
    const { result } = renderHook(() => useLogAscentAction({ ...climb, mirrored: true }));
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(true);
  });

  it('reads a solo flip from the live queue at tap time', () => {
    session.currentClimbQueueItem = { uuid: 'slot-1', climb: { ...climb, mirrored: true } };
    const { result } = renderHook(() => useLogAscentAction(climb));
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(true);
  });

  it('uses the supplied orientation when a different climb is current', () => {
    session.currentClimbQueueItem = { uuid: 'slot-2', climb: { ...climb, uuid: 'climb-2', mirrored: true } };
    const { result } = renderHook(() => useLogAscentAction(climb));
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(false);
  });

  it("keeps a crew's current occurrence orientation", () => {
    session.sessionId = 'session-1';
    session.currentClimbQueueItem = { uuid: 'slot-1', climb: { ...climb, mirrored: false } };
    const { result } = renderHook(() => useLogAscentAction(climb));
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(false);
  });
  it('keeps a retained history duplicate independent from the current occurrence', () => {
    session.currentClimbQueueItem = { uuid: 'slot-new', climb: { ...climb, mirrored: true } };
    session.queue = [{ uuid: 'slot-old', climb: { ...climb, mirrored: false } }];
    const { result } = renderHook(() => useLogAscentAction(climb, undefined, 'slot-old'));
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(false);
  });

  it('reads an explicit unmirror after rendering without reverting to the supplied true', () => {
    const { result } = renderHook(() => useLogAscentAction({ ...climb, mirrored: true }));
    session.currentClimbQueueItem = { uuid: 'slot-1', climb: { ...climb, mirrored: false } };
    act(() => result.current.handleLogAscentPress());
    expect(openedMirror()).toBe(false);
  });
});
