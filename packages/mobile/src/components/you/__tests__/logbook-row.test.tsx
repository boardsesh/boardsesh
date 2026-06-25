// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';

// Capture what ClimbListItemContent receives so we can assert the dual-grade
// pass-through (consensusGrade / gradeIsConsensus) the logbook row derives.
// deriveLogbookGradeDisplay (@boardsesh/logbook) is intentionally NOT mocked so
// the real decision + the row's label formatting are exercised end-to-end.
const mockClimbListItemContent = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    createAnimatedComponent: (C: unknown) => C,
  },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => {},
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' },
  runOnJS:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
  useSharedValue: (v: unknown) => ({ value: v }),
}));
vi.mock('react-native-gesture-handler', () => {
  // Defined inside the factory because vi.mock is hoisted above module-scope vars.
  const gestureChain = () => {
    const builder: Record<string, () => typeof builder> = {};
    for (const method of [
      'maxDuration',
      'maxDistance',
      'minDuration',
      'onStart',
      'onEnd',
      'activeOffsetY',
      'failOffsetX',
    ]) {
      builder[method] = () => builder;
    }
    return builder;
  };
  return {
    Gesture: { Tap: gestureChain, LongPress: gestureChain, Pan: gestureChain, Exclusive: (...g: unknown[]) => g[0] },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@boardsesh/profile-stats', () => ({
  getLayoutDisplayName: () => 'Kilter Original',
  formatTickRelativeTime: () => '2d ago',
}));
vi.mock('@boardsesh/play-view', () => ({ getGradeTextColor: () => '#fff' }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../ClimbListItemContent', () => ({
  ClimbListItemContent: (props: Record<string, unknown>) => {
    mockClimbListItemContent(props);
    return createElement('div', { 'data-testid': 'climb-content' });
  },
}));
// ClimbListItemContent transitively imports ClimbListThumbnail → expo native
// packages; mock it so the module worker doesn't traverse into them.
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => null,
  THUMBNAIL_WIDTH: 76,
  THUMBNAIL_HEIGHT: 96,
}));
vi.mock('../../use-swipe-arm', () => ({
  useSwipeArm: () => ({ armedRef: { current: false }, arm: () => {}, disarm: () => {} }),
}));
vi.mock('./profile-chart-colors', () => ({ gradeBadgeColor: () => '#000' }));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' }, withAlpha: (c: string) => c }));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#fff', systemGray: '#888', separator: '#ccc' },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 8 }), borderRadius: { sm: 4 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#f5f5f5',
      separator: '#ccc',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
    },
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (g: string | null | undefined) => g ?? null,
    formatGradeByDifficultyId: (id: number | null | undefined) => (id != null ? `V${id}` : null),
  }),
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: () => ({ boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: [1] }),
}));
vi.mock('../../../lib/haptics', () => ({
  hapticSelection: () => {},
  hapticMedium: () => {},
  hapticLight: () => {},
  hapticSuccess: () => {},
}));

import { LogbookRow } from '../LogbookRow';

function ascent(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    setterUsername: 'setter',
    boardType: 'kilter',
    boardId: 1,
    boardDisplayName: 'Kilter',
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: null,
    difficultyName: null,
    consensusDifficulty: null,
    consensusDifficultyName: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    climbedAt: '2026-06-15T10:00:00.000Z',
    frames: 'p1r1',
    ...overrides,
  } as AscentFeedItem;
}

function renderRow(item: AscentFeedItem) {
  render(createElement(LogbookRow, { ascent: item, onActivate: () => {} }));
  return mockClimbListItemContent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  mockClimbListItemContent.mockClear();
});

describe('LogbookRow — dual-grade pass-through', () => {
  it('marks the grade consensus-sourced and shows no secondary for an ungraded tick', () => {
    const props = renderRow(ascent({ difficulty: null, consensusDifficulty: 9, consensusDifficultyName: 'V9' }));
    expect(props).toMatchObject({ gradeIsConsensus: true, consensusGrade: null });
  });

  it('passes the consensus grade as a secondary when it disagrees with the logged grade', () => {
    const props = renderRow(
      ascent({ difficulty: 8, difficultyName: 'V8', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );
    expect(props).toMatchObject({ gradeIsConsensus: false, consensusGrade: 'V9' });
  });

  it('shows neither when the logged grade matches the consensus', () => {
    const props = renderRow(
      ascent({ difficulty: 9, difficultyName: 'V9', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );
    expect(props).toMatchObject({ gradeIsConsensus: false, consensusGrade: null });
  });
});
