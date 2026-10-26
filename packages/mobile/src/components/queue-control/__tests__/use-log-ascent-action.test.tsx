// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/queue';

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
vi.mock('../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: null }) }));
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
