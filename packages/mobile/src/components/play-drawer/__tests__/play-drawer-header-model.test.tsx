// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const reads = vi.hoisted(() => ({
  stats: vi.fn(),
  myGrade: vi.fn(),
  difficulty: 'V6',
  count: 12,
  quality: '3.5',
  resolved: 'V6',
  format: 'v',
  personal: false,
  reduceMotion: false,
  boldText: false,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  DrawerHeader: ({ center, trailing }: { center?: ReactNode; trailing?: ReactNode }) =>
    createElement('div', null, center, trailing),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../DraftChip', () => ({ DraftChip: () => null }));
vi.mock('../../ProjectChip', () => ({ ProjectChip: () => null }));
vi.mock('../../../theme/layout', () => ({ PLAY_HEADER_TRAILING_MIN_WIDTH: 44, WALL_STATE_PILL_TOUCH_HEIGHT: 44 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#777' } }),
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => reads.reduceMotion }));
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => reads.boldText }));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: reads.format }) }));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: reads.resolved, color: '#abc' }) }),
}));
vi.mock('../../../hooks/use-my-grade', () => ({
  useMyGrade: (...args: unknown[]) => {
    reads.myGrade(...args);
    return reads.personal ? { status: 'set', difficultyId: 20 } : { status: 'none' };
  },
}));
vi.mock('../../../lib/boardsesh-grade-display', () => ({
  renderDifficulty: (_difficulty: number, format: string) => ({ label: format === 'v' ? 'V8' : '7B', color: '#def' }),
}));
vi.mock('@boardsesh/board-react', () => ({
  useEffectiveClimbStats: (...args: unknown[]) => {
    reads.stats(...args);
    return { difficulty: reads.difficulty, ascensionistCount: reads.count, qualityAverage: reads.quality };
  },
}));

import { PreparedPlayDrawerHeader, useLivePlayDrawerHeaderModel } from '../PlayDrawerHeader';
const climb = {
  uuid: 'climb-1',
  name: 'Original',
  frames: 'p1r12',
  difficulty: 'V4',
  quality_average: '2',
  ascensionist_count: 3,
  setter_username: 'Setter',
  characteristics: ['no_match'],
  statsAngle: 30,
} as unknown as Climb;
const args = { climb, boardName: 'kilter' as const, layoutId: 1, angle: 40 };

describe('prepared live header geometry identity', () => {
  beforeEach(() => {
    reads.stats.mockClear();
    reads.myGrade.mockClear();
    reads.difficulty = 'V6';
    reads.count = 12;
    reads.quality = '3.5';
    reads.resolved = 'V6';
    reads.format = 'v';
    reads.personal = false;
    reads.reduceMotion = false;
    reads.boldText = false;
  });
  it('uses the actual live stats and derived grade instead of the raw climb projection', () => {
    const { result } = renderHook(() => useLivePlayDrawerHeaderModel(args));
    expect(result.current?.headerProps).toMatchObject({
      difficulty: 'V6',
      rawDifficulty: 'V6',
      ascensionistCount: 12,
      qualityAverage: '3.5',
      statsAngle: 30,
    });
  });
  it('memoizes unchanged visual output and invalidates every live or accessibility change', () => {
    const { result, rerender } = renderHook(() => useLivePlayDrawerHeaderModel(args));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    for (const update of [
      () => {
        reads.count++;
      },
      () => {
        reads.quality = '4';
      },
      () => {
        reads.resolved = 'V7';
      },
      () => {
        reads.personal = true;
      },
      () => {
        reads.format = 'font';
      },
      () => {
        reads.reduceMotion = true;
      },
      () => {
        reads.boldText = true;
      },
    ]) {
      const previousFingerprint = result.current?.layoutFingerprint;
      update();
      rerender();
      expect(result.current?.layoutFingerprint).not.toBe(previousFingerprint);
    }
    expect(result.current?.headerProps).toMatchObject({ difficulty: '7B', markedAsMine: true, secondaryGrade: 'V7' });
  });
  it('includes draft, hidden, rule/attribute, setter and stats-angle outputs', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Climb }) => useLivePlayDrawerHeaderModel({ ...args, climb: current }),
      { initialProps: { current: climb } },
    );
    const initial = result.current?.layoutFingerprint;
    rerender({
      current: {
        ...climb,
        is_draft: true,
        is_hidden: true,
        setter_username: 'Another',
        statsAngle: 35,
        characteristics: ['campus'],
      },
    });
    expect(result.current?.layoutFingerprint).not.toBe(initial);
    expect(result.current?.headerProps).toMatchObject({
      isDraft: true,
      isHidden: true,
      setterUsername: 'Another',
      statsAngle: 35,
      characteristics: ['campus'],
    });
  });
  it('keeps empty-pane hooks unconditional without querying an empty UUID', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Climb | null }) => useLivePlayDrawerHeaderModel({ ...args, climb: current }),
      { initialProps: { current: null as Climb | null } },
    );
    expect(result.current).toBeNull();
    expect(reads.stats).toHaveBeenLastCalledWith('kilter', 1, '', 40, expect.any(Object), { enabled: false });
    expect(reads.myGrade).toHaveBeenLastCalledWith('', 40, { localFallback: false });
    rerender({ current: climb });
    expect(result.current).not.toBeNull();
    expect(reads.stats).toHaveBeenLastCalledWith('kilter', 1, climb.uuid, 40, expect.any(Object), { enabled: true });
  });
  it('renders prepared output without adding a second set of live observers', () => {
    function CurrentHeader() {
      const model = useLivePlayDrawerHeaderModel(args);
      return model ? createElement(PreparedPlayDrawerHeader, { model }) : null;
    }
    const rendered = render(createElement(CurrentHeader));
    expect(rendered.getByText('V6')).toBeTruthy();
    expect(reads.stats).toHaveBeenCalledTimes(1);
    expect(reads.myGrade).toHaveBeenCalledTimes(1);
  });
});
