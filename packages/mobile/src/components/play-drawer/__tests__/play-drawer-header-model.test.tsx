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
  playCount: undefined as number | null | undefined,
  resolved: 'V6',
  format: 'v',
  personal: false,
  reduceMotion: false,
  boldText: false,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: (props: { children?: ReactNode; accessibilityLabel?: string; testID?: string }) =>
    createElement('div', { 'aria-label': props.accessibilityLabel, 'data-testid': props.testID }, props.children),
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'de' },
    t: (key: string, options?: { formattedCount?: string; plays?: string; angle?: number }) => {
      if (key === 'plays.count') return `${options?.formattedCount} Plays`;
      if (key === 'mobile.plays.countAtAngle') return `${options?.plays} bei ${options?.angle}°`;
      return key;
    },
  }),
}));
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
    return {
      difficulty: reads.difficulty,
      ascensionistCount: reads.count,
      qualityAverage: reads.quality,
      playCount: reads.playCount,
    };
  },
}));

import { LivePlayDrawerHeader, PreparedPlayDrawerHeader, useLivePlayDrawerHeaderModel } from '../PlayDrawerHeader';
import { PlayDrawerHeaderAccessibility } from '../PlayDrawerHeaderAccessibility';
import { CommunitySection } from '../CommunitySection';

vi.mock('../../../lib/graphql/hooks', () => ({ useClimbStatsHistory: () => ({ data: [] }) }));
vi.mock('../DifficultyByAngleChart', () => ({ DifficultyByAngleChart: () => null }));
vi.mock('../ClimbModerationStatus', () => ({ ClimbModerationStatus: () => null }));
vi.mock('../WallStatePill', () => ({ useWallStatePillAccessibility: () => null }));
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
    reads.playCount = undefined;
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
  it('keeps the fixed spoken header on the live angle and ignores a stale queue Plays projection', () => {
    function Header({ angle, detailPlayCount }: { angle: number; detailPlayCount?: number }) {
      const model = useLivePlayDrawerHeaderModel({
        ...args,
        angle,
        climb: { ...climb, angle, play_count: 99_999 },
        catalogPlays: { playCount: detailPlayCount ?? null, credentialScope: 0, authority: 'reference' },
      });
      return model ? (
        <>
          <PreparedPlayDrawerHeader model={model} />
          <PlayDrawerHeaderAccessibility model={model} pillState={null} pillBackTarget={null} pillLatched={false} />
        </>
      ) : null;
    }
    const { getByTestId, getByText, rerender, queryByText } = render(<Header angle={40} detailPlayCount={12_345} />);
    const spoken = () => getByTestId('play-drawer-header-accessibility').getAttribute('aria-label');
    expect(spoken()).toContain('12.345 Plays bei 40°');
    expect(queryByText(/99.999/)).toBeNull();

    rerender(<Header angle={30} />);
    expect(spoken()).not.toContain('Plays');
    rerender(<Header angle={30} detailPlayCount={0} />);
    expect(spoken()).toContain('0 Plays bei 30°');
    expect(getByText(/0 Plays/)).toBeTruthy();

    reads.playCount = null;
    rerender(<Header angle={30} detailPlayCount={0} />);
    expect(spoken()).not.toContain('Plays');
    expect(queryByText(/0 Plays/)).toBeNull();
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

describe('selected climb Community Plays', () => {
  it('explains Plays when the climb has no sends or grade history', () => {
    reads.count = 0;
    reads.quality = '0';
    const props = {
      climbUuid: climb.uuid,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      ascensionistCount: 0,
      qualityAverage: '0',
    };
    const { getByText, queryByText, rerender } = render(<CommunitySection {...props} playCount={0} />);
    expect(getByText('0 Plays')).toBeTruthy();
    expect(getByText('plays.explanation')).toBeTruthy();
    expect(queryByText('mobile.community.empty')).toBeNull();
    rerender(<CommunitySection {...props} playCount={null} />);
    expect(getByText('plays.label · plays.valueUnavailable')).toBeTruthy();
    expect(getByText('plays.explanation')).toBeTruthy();
  });
});

// A swipe's commit turns the neighbour's header into the current one. It used to
// be a different component there (Prepared for the current climb, Live for the
// neighbours), so the commit remounted the header after its title had landed.
describe('the swipe header across a commit', () => {
  it('keeps the neighbour’s header mounted when it becomes the current one', () => {
    const { result } = renderHook(() => useLivePlayDrawerHeaderModel(args));
    const model = result.current;
    if (!model) throw new Error('no model');
    const { getByText, rerender } = render(createElement(LivePlayDrawerHeader, { ...args, peek: true }));
    const drawnName = getByText('Original');

    rerender(createElement(LivePlayDrawerHeader, { ...args, climb: null, model, onLongPressName: vi.fn() }));

    // The same DOM node: React kept the header, and only its props changed.
    expect(getByText('Original')).toBe(drawnName);
  });
});
