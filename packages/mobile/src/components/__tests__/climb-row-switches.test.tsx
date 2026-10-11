// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// What each Climb list switch does to a row. `climb-row-default-output.test.tsx`
// pins the row a climber gets who has touched nothing; this file pins the other
// side: every switch takes exactly its own element off the row, on every kind of
// host, and a row without a thumbnail keeps one height from its first paint.
//
// The row, its content and the tag strip are the real modules. Only what they
// read is controlled: the two stores (stats, logbook), the grade settings and
// the playlists.

type StatusEntry = { status: 'flash' | 'send' | 'attempt'; is_ascent: boolean; tries: number; is_mirror: boolean };
type Logbook = { logbookByClimbAngle: Map<string, StatusEntry[]> };

const live = vi.hoisted(() => ({
  // Both stores count who is subscribed, so a test can ask what a row costs.
  logbook: { listeners: new Set<() => void>(), current: null as unknown },
  stats: { listeners: new Set<() => void>() },
  personalGrades: true,
  boardseshGrades: false,
  myGrade: { status: 'unknown' } as { status: 'unknown' } | { status: 'set'; difficultyId: number; climbedAt: null },
  thumbnailMounts: 0,
  fontScale: 1,
  playlistsById: new Map<string, { name: string; color?: string; icon?: string }>(),
}));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  type ViewProps = {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityElementsHidden?: boolean;
    accessibilityActions?: { name: string; label?: string }[];
  };
  const View = ({
    children,
    style,
    testID,
    accessibilityLabel,
    accessibilityRole,
    accessibilityElementsHidden,
    accessibilityActions,
  }: ViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-role': accessibilityRole,
        'data-silent': accessibilityElementsHidden ? 'true' : undefined,
        'data-actions': accessibilityActions?.map((action) => action.name).join(','),
        'data-style': JSON.stringify(flattenStyle(style)),
      },
      children,
    );
  return {
    useWindowDimensions: () => ({ fontScale: live.fontScale }),
    Platform: { OS: 'ios', select: () => undefined },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <Styles,>(styles: Styles): Styles => styles, flatten: flattenStyle, hairlineWidth: 0.5 },
    View,
  };
});

vi.mock('react-native-reanimated', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  const AnimatedView = ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children);
  return {
    default: { View: AnimatedView },
    useAnimatedStyle: (build: () => unknown) => build(),
    useAnimatedReaction: () => undefined,
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
    useSharedValue: (initial: unknown) => {
      const shared = useRef({ value: initial });
      return shared.current;
    },
    withSpring: (target: unknown) => target,
    runOnJS:
      (run: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        run(...args),
  };
});

vi.mock('react-native-gesture-handler', () => {
  // Every method returns the same builder, so any chain the row configures resolves.
  const makeGesture = (): unknown => {
    const gesture: unknown = new Proxy({}, { get: () => () => gesture });
    return gesture;
  };
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
    Gesture: {
      Pan: makeGesture,
      Tap: makeGesture,
      LongPress: makeGesture,
      Exclusive: makeGesture,
      Simultaneous: makeGesture,
    },
  };
});

vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { formattedCount?: string; direction?: string; status?: string }) => {
      if (key === 'sends' && options?.formattedCount) return `${options.formattedCount} sends`;
      if (key === 'mobile.climbRow.directionStatus' && options) return `${options.direction}: ${options.status}`;
      return key;
    },
  }),
}));

vi.mock('@boardsesh/board-react', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribeTo = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const subscribeToLogbook = subscribeTo(live.logbook.listeners);
  const subscribeToStats = subscribeTo(live.stats.listeners);
  const noStatsChange = () => 0;
  return {
    useOptionalBoardLogbook: () => useSyncExternalStore(subscribeToLogbook, () => live.logbook.current),
    logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
    useEffectiveClimbStats: (
      _boardName: string,
      _layoutId: number,
      _climbUuid: string,
      _angle: number,
      base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
    ) => {
      // One listener per mounted reader of the stats store, like the real hook.
      useSyncExternalStore(subscribeToStats, noStatsChange);
      return {
        ascensionistCount: base.ascensionistCount ?? 0,
        qualityAverage: base.qualityAverage ?? null,
        difficulty: base.difficulty ?? null,
      };
    },
  };
});

vi.mock('../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => live.boardseshGrades,
  useDisplayGrade: () => ({
    boardseshActive: live.boardseshGrades,
    resolveGrade: () => ({ label: 'V4', color: '#44AA44', isBoardsesh: false }),
  }),
}));
vi.mock('../../hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => live.personalGrades }));
// Like the real hook: it reads the logbook, so every mounted caller is one
// listener there, and it reports no grade while personal grades are off.
vi.mock('../../hooks/use-my-grade', async () => {
  const { useOptionalBoardLogbook } = await import('@boardsesh/board-react');
  return {
    useMyGrade: () => {
      useOptionalBoardLogbook();
      return live.personalGrades ? live.myGrade : { status: 'none' };
    },
  };
});
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../providers/theme-provider', async () => {
  const { textStyles } = await import('../../theme/typography');
  return {
    useOptionalTheme: () => null,
    useTheme: () => ({
      variant: 'liquidGlass',
      textStyles,
      systemColors: { background: '#fff', separator: '#ccc', secondaryLabel: '#8E8E93', fill: '#E5E5EA' },
      brandColors: { primary: '#6D28D9', success: '#0a0' },
      m3: { surfaceVariant: '#333', onSurfaceVariant: '#ccc' },
    }),
  };
});
vi.mock('../../theme/variants', () => ({
  selectByVariant: (variant: string, byVariant: Record<string, unknown>) => byVariant[variant],
}));
vi.mock('../../providers/playlists-provider', () => ({
  usePlaylistsContextOptional: () => ({ playlistsById: live.playlistsById }),
}));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticMedium: vi.fn(), hapticSuccess: vi.fn() }));

vi.mock('../Text', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  type TextProps = {
    children?: ReactNode;
    style?: unknown;
    variant?: string;
    numberOfLines?: number;
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
  };
  return {
    Text: ({ children, style, variant, numberOfLines, accessibilityLabel, accessibilityElementsHidden }: TextProps) =>
      createElement(
        'span',
        {
          'data-variant': variant,
          'data-lines': numberOfLines,
          'aria-label': accessibilityLabel,
          'data-silent': accessibilityElementsHidden ? 'true' : undefined,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('../ClimbListThumbnail', async () => {
  const { useEffect } = await import('react');
  const metrics = await import('../climb-list-thumbnail-metrics');
  return {
    ...metrics,
    ClimbListThumbnail: () => {
      useEffect(() => {
        live.thumbnailMounts += 1;
      }, []);
      return createElement('i', { 'data-thumbnail': 'true' });
    },
  };
});

vi.mock('../Icon', () => ({
  Icon: ({ name, size }: { name: string; size: number }) =>
    createElement('i', { 'data-icon': name, 'data-size': size }),
}));

vi.mock('../PressableSurface', () => {
  const Surface = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { PressableSurface: Surface, StaticPressableSurface: Surface };
});

import { favoritesStore, playlistMembershipStore } from '@boardsesh/climb-actions';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { ClimbListRow } from '../ClimbListRow';
import {
  CLIMB_ROW_FIELD_IDS,
  DEFAULT_CLIMB_ROW_DISPLAY,
  CLIMB_ROW_PRESETS,
  type ClimbRowDisplay,
  type ClimbRowFieldId,
} from '../../lib/climb-row-display';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../lib/climb-row-display-preference';

// A no-break space: what a line that holds its height with nothing in it contains.
const BLANK = '\u00A0';

const climb = {
  uuid: 'c1',
  name: 'Boulder Problem',
  frames: 'p1r12p2r13',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 12,
  setter_username: 'setterx',
};
// Nothing known about it: no sends, no rating, no setter.
const bareClimb = { ...climb, quality_average: '0', ascensionist_count: 0, setter_username: '' };

const kilter = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
// A board that mirrors: the row tracks each direction.
const tension = { ...kilter, boardName: 'tension' as const };

const ALL_ON: ClimbRowDisplay = {
  thumbnail: true,
  communityGrade: true,
  sends: true,
  rating: true,
  setter: true,
  sentMark: true,
  progress: true,
  playlistTags: true,
  quickActions: true,
};
const ALL_OFF: ClimbRowDisplay = {
  thumbnail: false,
  communityGrade: false,
  sends: false,
  rating: false,
  setter: false,
  sentMark: false,
  progress: false,
  playlistTags: false,
  quickActions: false,
};

const sent: StatusEntry = { status: 'send', is_ascent: true, tries: 2, is_mirror: false };

function setLogbook(entries: Record<string, StatusEntry[]>) {
  const logbook: Logbook = { logbookByClimbAngle: new Map(Object.entries(entries)) };
  live.logbook.current = logbook;
  for (const listener of live.logbook.listeners) listener();
}

function store(display: ClimbRowDisplay) {
  for (const fieldId of CLIMB_ROW_FIELD_IDS) setClimbRowField(fieldId, display[fieldId]);
}

/**
 * What the row draws, in document order: the thumbnail, each glyph, each
 * testID, each text. The detail line is one entry per token, so a switch that
 * takes one token out of it reads as one entry gone.
 */
function outline(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-thumbnail], [data-variant], [data-icon], [data-testid]')].flatMap(
    (node) => {
      if (node.hasAttribute('data-thumbnail')) return ['thumbnail'];
      if (node.hasAttribute('data-icon')) return [`icon:${node.getAttribute('data-icon')}`];
      if (node.hasAttribute('data-testid')) return [`#${node.getAttribute('data-testid')}`];
      const variant = node.getAttribute('data-variant');
      const text = node.textContent ?? '';
      return variant === 'footnote' ? text.split(' · ').map((token) => `footnote:${token}`) : [`${variant}:${text}`];
    },
  );
}

function styleOf(node: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

const NAME = '[data-variant="body"]';

/** The row's text column: the block that holds the name's line. */
function textColumnOf(container: HTMLElement): Element {
  const nameLine = container.querySelector(NAME)?.parentElement;
  // A resolved climb's name sits in a line of its own, beside its glyphs. The
  // placeholder for an unresolved one is a bare name in the column.
  const column = styleOf(nameLine).flexDirection === 'row' ? nameLine?.parentElement : nameLine;
  if (!column) throw new Error('The row drew no text column');
  return column;
}

/** The kinds of line in the text column, top to bottom, with what each holds. */
function linesOf(container: HTMLElement): string[] {
  return [...textColumnOf(container).children].map((line) => {
    const testID = line.getAttribute('data-testid');
    if (testID) return `#${testID}`;
    if (line.matches(NAME) || line.querySelector(NAME)) return 'name';
    return `${line.getAttribute('data-variant')}:${line.textContent}`;
  });
}

beforeEach(() => {
  resetClimbRowDisplayForTests();
  favoritesStore.reset();
  playlistMembershipStore.reset();
  live.logbook.current = null;
  live.personalGrades = true;
  live.boardseshGrades = false;
  live.myGrade = { status: 'unknown' };
  live.thumbnailMounts = 0;
  live.fontScale = 1;
  live.playlistsById = new Map([['p1', { name: 'Project@30' }]]);
});

// A row with something in every optional place: favourited, sent, in a
// playlist, and graded V10 by the climber where the community says V4.
function loadTheRow() {
  favoritesStore.setIsFavorited('c1', true);
  playlistMembershipStore.setMembershipForClimb('c1', ['p1']);
  live.logbook.current = { logbookByClimbAngle: new Map([['c1:40', [sent]]]) } satisfies Logbook;
  live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
}

type Surface = {
  label: string;
  draw: () => ReturnType<typeof render>;
  /** What the surface draws with every switch on. */
  everything: string[];
  /** What each switch takes off it. Nothing, where the surface never drew that element. */
  takes: Record<ClimbRowFieldId, string[]>;
};

const SURFACES: Surface[] = [
  {
    label: 'the Climbs list row (tags, heart and ⋮ allowed)',
    draw: () =>
      render(
        <ClimbListRow
          climb={climb as unknown as Climb}
          {...kilter}
          onOpenActions={vi.fn()}
          showPlaylistChips
          showFavorite
          showMoreButton
        />,
      ),
    everything: [
      '#climb-row',
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4',
      'footnote:12 sends',
      'footnote:4.5★',
      'footnote:setterx',
      '#climb-row-tags-line',
      'caption1:Project@30',
      'icon:favorite.fill',
      'icon:tick.outline',
      'icon:person',
      'title3:V10',
      '#climb-row-more-button',
      'icon:more.vertical',
    ],
    takes: {
      thumbnail: ['thumbnail'],
      communityGrade: ['footnote:V4'],
      sends: ['footnote:12 sends'],
      rating: ['footnote:4.5★'],
      setter: ['footnote:setterx'],
      sentMark: ['icon:tick.outline'],
      progress: [],
      playlistTags: ['#climb-row-tags-line', 'caption1:Project@30'],
      quickActions: ['#climb-row-more-button', 'icon:more.vertical'],
    },
  },
  {
    label: 'a host that shows no ascent status, tags, heart or ⋮ (the playlist editor)',
    draw: () => render(<ClimbListItemContent climb={climb} {...kilter} showAscentStatus={false} />),
    everything: [
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4',
      'footnote:12 sends',
      'footnote:4.5★',
      'footnote:setterx',
      'icon:person',
      'title3:V10',
    ],
    takes: {
      thumbnail: ['thumbnail'],
      communityGrade: ['footnote:V4'],
      sends: ['footnote:12 sends'],
      rating: ['footnote:4.5★'],
      setter: ['footnote:setterx'],
      sentMark: [],
      progress: [],
      playlistTags: [],
      quickActions: [],
    },
  },
  {
    label: 'a host that replaces the detail line (a session row)',
    draw: () =>
      render(
        <ClimbListItemContent
          climb={climb}
          {...kilter}
          showAscentStatus={false}
          primarySubtitleOverride="Alex"
          subtitleDetailParts={['2nd go', 'set by setterx']}
        />,
      ),
    everything: [
      'thumbnail',
      'body:Boulder Problem',
      'footnote:Alex',
      'caption1:2nd go · set by setterx',
      'icon:person',
      'title3:V10',
    ],
    takes: {
      thumbnail: ['thumbnail'],
      communityGrade: [],
      sends: [],
      rating: [],
      setter: [],
      sentMark: [],
      progress: [],
      playlistTags: [],
      quickActions: [],
    },
  },
];

describe.each(SURFACES)('each switch on $label', ({ draw, everything, takes }) => {
  beforeEach(() => {
    loadTheRow();
    store(ALL_ON);
  });

  it('draws every element with every switch on', () => {
    expect(outline(draw().container)).toEqual(everything);
  });

  it.each(CLIMB_ROW_FIELD_IDS)('%s off takes exactly its own element off the row', (fieldId) => {
    const { container } = draw();

    act(() => setClimbRowField(fieldId, false));

    // Entry by entry, so a switch that also moved or re-ordered something fails here.
    expect(outline(container)).toEqual(everything.filter((entry) => !takes[fieldId].includes(entry)));
  });

  it.each(CLIMB_ROW_FIELD_IDS)('%s back on puts it back', (fieldId) => {
    store({ ...ALL_ON, [fieldId]: false });
    const { container } = draw();

    act(() => setClimbRowField(fieldId, true));

    expect(outline(container)).toEqual(everything);
  });
});

describe('what no switch can take off a row', () => {
  it('keeps the name, the grade, the status chips and the rule badges with every switch off', () => {
    store(ALL_OFF);
    const marked = {
      ...climb,
      is_draft: true,
      is_hidden: true,
      missingHoldCount: 2,
      benchmark_difficulty: '20',
      characteristics: ['no_match'],
    };

    const { container } = render(<ClimbListItemContent climb={marked} {...kilter} showFavorite showPlaylistChips />);

    expect(outline(container)).toEqual([
      'body:Boulder Problem',
      'icon:benchmark',
      'icon:no.match',
      '#climb-row-draft-chip',
      'caption2:createClimbForm.draftBadge',
      '#climb-row-hidden-chip',
      'icon:visibility.off',
      'caption2:mobile.hidden.chip',
      '#climb-row-lost-holds-chip',
      'icon:frame.remove',
      'caption2:mobile.lostHolds.chip',
      'title3:V4',
    ]);
  });

  it('keeps the favourite heart, which has no switch', () => {
    store(ALL_OFF);
    favoritesStore.setIsFavorited('c1', true);

    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} showFavorite />);

    expect(outline(container)).toEqual(['body:Boulder Problem', 'icon:favorite.fill', 'title3:V4']);
  });
});

describe('the sent mark switch', () => {
  it('takes the glyph beside the grade off a board that does not mirror', () => {
    setLogbook({ 'c1:40': [sent] });
    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} />);
    expect(outline(container)).toContain('icon:tick.outline');

    act(() => setClimbRowField('sentMark', false));

    expect(outline(container)).not.toContain('icon:tick.outline');
    expect(container.querySelector('[aria-label="mobile.climbRow.ascentStatus.send"]')).toBeNull();
  });

  it('takes both direction lines off a board that mirrors', () => {
    setLogbook({ 'c1:40': [sent, { ...sent, is_mirror: true }] });
    const { container } = render(<ClimbListItemContent climb={climb} {...tension} />);
    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends',
      'footnote:4.5★',
      'footnote:setterx',
      'icon:tick.outline',
      'caption2:mobile.logbook.originalTag',
      'icon:tick.outline',
      'caption2:mobile.logbook.mirroredTag',
      'title3:V4',
    ]);

    act(() => setClimbRowField('sentMark', false));

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends',
      'footnote:4.5★',
      'footnote:setterx',
      'title3:V4',
    ]);
  });

  it('stays off where the host shows the status itself, whatever the switch says', () => {
    setLogbook({ 'c1:40': [sent, { ...sent, is_mirror: true }] });

    const mirrored = render(<ClimbListItemContent climb={climb} {...tension} showAscentStatus={false} />);
    const plain = render(<ClimbListItemContent climb={climb} {...kilter} showAscentStatus={false} />);

    expect(outline(mirrored.container)).not.toContain('icon:tick.outline');
    expect(outline(plain.container)).not.toContain('icon:tick.outline');
  });
});

describe('the detail line: sends, rating, setter and the community grade', () => {
  const combinations = [true, false].flatMap((sends) =>
    [true, false].flatMap((rating) =>
      [true, false].flatMap((setter) =>
        [true, false].map((communityGrade) => ({ sends, rating, setter, communityGrade })),
      ),
    ),
  );

  it.each(combinations)(
    'sends $sends, rating $rating, setter $setter, community grade $communityGrade',
    ({ sends, rating, setter, communityGrade }) => {
      live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends, rating, setter, communityGrade };

      const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

      const tokens = [
        communityGrade ? 'V4' : null,
        sends ? '12 sends' : null,
        rating ? '4.5★' : null,
        setter ? 'setterx' : null,
      ].filter((token) => token !== null);
      const nameLine = container.querySelector('[data-variant="body"]')?.parentElement;

      if (sends || rating || setter) {
        // One line under the name, in today's order, with exactly the tokens that are on.
        expect(linesOf(container)).toEqual(['name', `footnote:${tokens.join(' · ')}`]);
        expect(nameLine?.querySelector('[data-variant="footnote"]')).toBeNull();
        return;
      }

      // None of the line's own tokens: no line. The community grade does not
      // open one for itself; it docks at the end of the name line.
      expect(linesOf(container)).toEqual(['name']);
      expect(nameLine?.querySelector('[data-variant="footnote"]')?.textContent ?? null).toBe(
        communityGrade ? 'V4' : null,
      );
    },
  );

  it('docks the community grade after the name and its glyphs, in the detail line’s grey', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

    const { container } = render(
      <ClimbListItemContent climb={{ ...climb, benchmark_difficulty: '20' }} {...kilter} display={display} />,
    );

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'icon:benchmark',
      'footnote:V4',
      'icon:person',
      'title3:V10',
    ]);
    const docked = container.querySelector('[data-variant="footnote"]');
    // The name gives way when the row is narrow, never the token.
    expect(styleOf(docked)).toEqual({ opacity: 0.6, marginStart: 6, flexShrink: 0 });
    expect(docked?.getAttribute('data-lines')).toBe('1');
  });

  it('draws no docked token for a climb whose column already shows the community grade', () => {
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

    expect(outline(container)).toEqual(['thumbnail', 'body:Boulder Problem', 'title3:V4']);
  });

  it('keeps the set-angle marker under the grade on a row with no detail line to move it to', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

    const { container } = render(
      <ClimbListItemContent climb={{ ...climb, statsAngle: 45 }} {...kilter} display={display} />,
    );

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4',
      'icon:person',
      'title3:V10',
      'caption2:mobile.climbRow.setAngleMarker',
    ]);
  });

  describe('the "Project" fallback', () => {
    it.each([
      { rating: true, setter: true },
      { rating: false, setter: true },
      { rating: true, setter: false },
      { rating: false, setter: false },
    ])('stands in while sends is on (rating $rating, setter $setter)', ({ rating, setter }) => {
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, rating, setter };

      const { container } = render(<ClimbListItemContent climb={bareClimb} {...kilter} display={display} />);

      expect(linesOf(container)).toEqual(['name', 'footnote:mobile.climbRow.projectFallback']);
    });

    it.each([
      { rating: true, setter: true },
      { rating: false, setter: true },
      { rating: true, setter: false },
    ])('goes with sends: the line stays, empty (rating $rating, setter $setter)', ({ rating, setter }) => {
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating, setter };

      const { container } = render(<ClimbListItemContent climb={bareClimb} {...kilter} display={display} />);

      expect(linesOf(container)).toEqual(['name', `footnote:${BLANK}`]);
    });

    it('leaves no line at all once sends, rating and setter are all off', () => {
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

      const { container } = render(<ClimbListItemContent climb={bareClimb} {...kilter} display={display} />);

      expect(linesOf(container)).toEqual(['name']);
    });

    it('is not said of a climb that has a setter, just because the setter is switched off', () => {
      const unsent = { ...bareClimb, setter_username: 'setterx' };
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, setter: false };

      const { container } = render(<ClimbListItemContent climb={unsent} {...kilter} display={display} />);

      expect(linesOf(container)).toEqual(['name', `footnote:${BLANK}`]);
    });
  });
});

describe('accessible names and drag-row geometry', () => {
  const textOnly = { ...DEFAULT_CLIMB_ROW_DISPLAY, thumbnail: false };

  it.each([
    { fontScale: 1, expectedLines: '1' },
    { fontScale: 1.29, expectedLines: '1' },
    { fontScale: 1.3, expectedLines: '2' },
    { fontScale: 1.5, expectedLines: '2' },
  ])('allows $expectedLines name lines at font scale $fontScale', ({ fontScale, expectedLines }) => {
    live.fontScale = fontScale;
    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={textOnly} />);

    expect(container.querySelector(NAME)?.getAttribute('data-lines')).toBe(expectedLines);
    expect(styleOf(container.querySelector(NAME)).minHeight).toBe(
      expectedLines === '2' ? 22 * fontScale * 2 : undefined,
    );
  });

  it('changes the wrapping limit when system text size changes on a mounted row', () => {
    const row = <ClimbListItemContent climb={climb} {...kilter} display={textOnly} />;
    const { container, rerender } = render(row);
    expect(container.querySelector(NAME)?.getAttribute('data-lines')).toBe('1');

    live.fontScale = 1.5;
    rerender(<ClimbListItemContent climb={{ ...climb }} {...kilter} display={textOnly} />);

    expect(container.querySelector(NAME)?.getAttribute('data-lines')).toBe('2');
  });

  it('keeps drag-host names on one line at large text sizes', () => {
    live.fontScale = 1.5;
    const { container } = render(
      <ClimbListItemContent climb={climb} {...kilter} display={textOnly} allowNameWrapping={false} />,
    );

    expect(container.querySelector(NAME)?.getAttribute('data-lines')).toBe('1');
    expect(styleOf(container.querySelector(NAME)).minHeight).toBeUndefined();
  });

  it('reserves the same two name lines before an unresolved climb loads', () => {
    live.fontScale = 1.5;
    const unresolved = render(<ClimbListItemContent climb={null} {...kilter} display={textOnly} />);
    const resolved = render(<ClimbListItemContent climb={climb} {...kilter} display={textOnly} />);

    for (const { container } of [unresolved, resolved]) {
      expect(container.querySelector(NAME)?.getAttribute('data-lines')).toBe('2');
      expect(styleOf(container.querySelector(NAME)).minHeight).toBe(66);
    }
  });

  it('keeps fixed warning badges on the name line in drag hosts', () => {
    live.fontScale = 1.5;
    const warningClimb = { ...climb, missingHoldCount: 2, is_draft: true, is_hidden: true };
    const { container } = render(
      <ClimbListItemContent climb={warningClimb} {...kilter} display={textOnly} allowNameWrapping={false} />,
    );
    const nameRow = container.querySelector(NAME)?.parentElement;

    expect(linesOf(container)).toEqual(['name', 'footnote:4.5★ · setterx']);
    for (const testID of ['climb-row-lost-holds-chip', 'climb-row-draft-chip', 'climb-row-hidden-chip']) {
      expect(nameRow?.querySelector(`[data-testid="${testID}"]`)).not.toBeNull();
    }
  });

  it('keeps the separate warning line available in ordinary list rows', () => {
    const { container } = render(
      <ClimbListItemContent climb={{ ...climb, missingHoldCount: 2 }} {...kilter} display={textOnly} />,
    );
    const nameRow = container.querySelector(NAME)?.parentElement;
    const warning = container.querySelector('[data-testid="climb-row-lost-holds-chip"]');

    expect(warning).not.toBeNull();
    expect(nameRow?.contains(warning)).toBe(false);
    expect(textColumnOf(container).children).toHaveLength(3);
  });
});

describe('a row without a thumbnail', () => {
  const textOnly = { ...DEFAULT_CLIMB_ROW_DISPLAY, thumbnail: false };

  it('mounts no thumbnail and reserves no column for one: the text column comes first', () => {
    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={textOnly} />);

    expect(live.thumbnailMounts).toBe(0);
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.children).toHaveLength(2);
    expect(container.children[0]).toBe(textColumnOf(container));
    // No block anywhere in the row is the thumbnail's size.
    const sizes = [...container.querySelectorAll('[data-style]')].map((node) => styleOf(node).width);
    expect(sizes).not.toContain(76);
  });

  it('mounts the thumbnail again the moment it is switched back on', () => {
    store(textOnly);
    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} />);
    expect(live.thumbnailMounts).toBe(0);

    act(() => setClimbRowField('thumbnail', true));

    expect(live.thumbnailMounts).toBe(1);
    expect(container.children).toHaveLength(3);
    expect(styleOf(container.children[0])).toEqual({ width: 76, height: 96, flexShrink: 0, position: 'relative' });
  });

  it('floors the text column at a touch target less the row’s padding, and only without a thumbnail', () => {
    const without = render(<ClimbListItemContent climb={climb} {...kilter} display={textOnly} />);
    const withOne = render(<ClimbListItemContent climb={climb} {...kilter} />);

    // 44pt, less the 8pt every host pads above and below.
    expect(styleOf(textColumnOf(without.container))).toEqual({
      flex: 1,
      minWidth: 0,
      justifyContent: 'center',
      gap: 2,
      minHeight: 28,
    });
    expect(styleOf(textColumnOf(withOne.container))).toEqual({
      flex: 1,
      minWidth: 0,
      justifyContent: 'center',
      gap: 2,
    });
  });

  it('draws the placeholder for an unresolved climb without the thumbnail block too', () => {
    const { container } = render(<ClimbListItemContent climb={null} {...kilter} display={textOnly} />);

    expect(container.children).toHaveLength(2);
    expect(styleOf(container.children[0]).minHeight).toBe(28);
    expect(outline(container)).toEqual(['body:mobile.queue.unknownClimb', `footnote:${BLANK}`, `title3:${BLANK}`]);
  });

  it('reserves a silent grade line before a compact large-text climb resolves', () => {
    live.fontScale = 1.5;
    const namesOnly = { ...CLIMB_ROW_PRESETS.namesOnly, quickActions: true };
    const { container, rerender } = render(
      <ClimbListItemContent climb={null} {...kilter} display={namesOnly} allowNameWrapping={false} />,
    );
    const reservedGrade = container.querySelector('[data-variant="title3"]');
    expect(reservedGrade?.textContent).toBe(BLANK);
    expect(reservedGrade?.getAttribute('data-silent')).toBe('true');
    expect(container.querySelector('[data-variant="body"]')?.getAttribute('data-lines')).toBe('1');
    rerender(<ClimbListItemContent climb={climb} {...kilter} display={namesOnly} allowNameWrapping={false} />);
    expect(container.querySelector('[data-variant="title3"]')).not.toBeNull();
  });

  it('keeps drag-host direction labels on one line even with pictures', () => {
    loadTheRow();
    live.fontScale = 1.5;
    const { container } = render(<ClimbListItemContent climb={climb} {...tension} allowNameWrapping={false} />);
    for (const label of container.querySelectorAll('[data-variant="caption2"]')) {
      expect(label.getAttribute('data-lines')).toBe('1');
    }
    expect(container.querySelectorAll('[data-variant="caption2"]').length).toBeGreaterThan(0);
  });

  it('gives that placeholder the lines its row will have, so the row does not move when the climb lands', () => {
    const display = { ...textOnly, playlistTags: true };
    const surface = { ...tension, display, showPlaylistChips: true };

    const unresolved = render(<ClimbListItemContent climb={null} {...surface} />);
    const resolved = render(<ClimbListItemContent climb={climb} {...surface} />);

    const lineKinds = (container: HTMLElement) => linesOf(container).map((line) => line.split(':')[0]);
    expect(lineKinds(unresolved.container)).toEqual([
      'name',
      'footnote',
      '#climb-row-personal-line',
      '#climb-row-tags-line',
    ]);
    expect(lineKinds(resolved.container)).toEqual(lineKinds(unresolved.container));
  });

  describe('lines whose data lands after the first paint', () => {
    it('holds the playlist tags line empty, then fills that same line', () => {
      const display = { ...textOnly, playlistTags: true };
      const { container } = render(
        <ClimbListItemContent climb={climb} {...kilter} display={display} showPlaylistChips />,
      );
      const before = linesOf(container);
      const tagsLine = container.querySelector('[data-testid="climb-row-tags-line"]');

      // There from the first paint: a line of tags with a blank label in it.
      expect(before).toEqual(['name', 'footnote:12 sends · 4.5★ · setterx', '#climb-row-tags-line']);
      expect(tagsLine?.textContent).toBe(BLANK);
      expect(tagsLine?.getAttribute('data-silent')).toBe('true');

      act(() => playlistMembershipStore.setMembershipForClimb('c1', ['p1']));

      expect(linesOf(container)).toEqual(before);
      const filled = container.querySelector('[data-testid="climb-row-tags-line"]');
      expect(filled?.textContent).toBe('Project@30');
      // The same line box: the reserved one was drawn with the tags line's own style.
      expect(styleOf(filled)).toEqual(styleOf(tagsLine));
    });

    it('holds no tags line beside a thumbnail, where it grows inside the thumbnail’s height', () => {
      const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true };

      const { container } = render(
        <ClimbListItemContent climb={climb} {...kilter} display={display} showPlaylistChips />,
      );

      expect(linesOf(container)).toEqual(['name', 'footnote:12 sends · 4.5★ · setterx']);
    });

    it('holds one line for a mirror board’s directions, then lays both out on it', () => {
      const { container } = render(<ClimbListItemContent climb={climb} {...tension} display={textOnly} />);
      const before = linesOf(container);
      const personalLine = container.querySelector('[data-testid="climb-row-personal-line"]');

      expect(before).toEqual(['name', 'footnote:12 sends · 4.5★ · setterx', '#climb-row-personal-line']);
      expect(outline(personalLine as HTMLElement)).toEqual([`caption2:${BLANK}`]);
      expect(personalLine?.querySelector('[data-variant="caption2"]')?.getAttribute('data-silent')).toBe('true');

      act(() => setLogbook({ 'c1:40': [sent, { ...sent, is_mirror: true }] }));

      expect(linesOf(container)).toEqual(before);
      const filled = container.querySelector('[data-testid="climb-row-personal-line"]');
      // Both directions, side by side on the one line, each still spoken in full.
      expect(styleOf(filled)).toMatchObject({ flexDirection: 'row', alignItems: 'center', minHeight: 12 });
      expect(styleOf(filled)).toEqual(styleOf(personalLine));
      expect(filled?.children).toHaveLength(2);
      expect([...(filled?.children ?? [])].map((status) => status.getAttribute('aria-label'))).toEqual([
        'mobile.logbook.originalTag: mobile.climbRow.ascentStatus.send',
        'mobile.logbook.mirroredTag: mobile.climbRow.ascentStatus.send',
      ]);
      // Neither label may wrap, or the line would grow.
      expect(
        [...(filled?.querySelectorAll('[data-variant="caption2"]') ?? [])].map((label) =>
          label.getAttribute('data-lines'),
        ),
      ).toEqual(['1', '1']);
    });

    it('holds the same line with only one direction climbed', () => {
      setLogbook({ 'c1:40': [{ ...sent, is_mirror: true }] });

      const { container } = render(<ClimbListItemContent climb={climb} {...tension} display={textOnly} />);

      expect(linesOf(container)).toEqual(['name', 'footnote:12 sends · 4.5★ · setterx', '#climb-row-personal-line']);
      expect(container.querySelector('[data-testid="climb-row-personal-line"]')?.children).toHaveLength(1);
    });

    it('holds no personal line with the sent mark off, or where the host shows the status itself', () => {
      const off = render(
        <ClimbListItemContent climb={climb} {...tension} display={{ ...textOnly, sentMark: false }} />,
      );
      const suppressed = render(
        <ClimbListItemContent climb={climb} {...tension} display={textOnly} showAscentStatus={false} />,
      );

      expect(off.container.querySelector('[data-testid="climb-row-personal-line"]')).toBeNull();
      expect(suppressed.container.querySelector('[data-testid="climb-row-personal-line"]')).toBeNull();
    });

    it('stacks a mirror board’s directions beside a thumbnail, as before, and holds nothing', () => {
      const { container } = render(<ClimbListItemContent climb={climb} {...tension} />);
      expect(container.querySelector('[data-testid="climb-row-personal-line"]')).toBeNull();
      expect(linesOf(container)).toEqual(['name', 'footnote:12 sends · 4.5★ · setterx']);

      act(() => setLogbook({ 'c1:40': [sent, { ...sent, is_mirror: true }] }));

      expect(container.querySelector('[data-testid="climb-row-personal-line"]')).toBeNull();
      expect(textColumnOf(container).querySelectorAll('[data-icon="tick.outline"]')).toHaveLength(2);
    });

    it('keeps the line under the grade when the set-angle marker moves to the detail line', () => {
      const { container } = render(
        <ClimbListItemContent climb={{ ...climb, statsAngle: 45 }} {...kilter} display={textOnly} />,
      );
      const gradeColumn = () => container.querySelector('[data-variant="title3"]')?.parentElement?.parentElement;

      // Before your tick lands the marker is under the community's grade.
      expect(gradeColumn()?.children).toHaveLength(2);
      expect(gradeColumn()?.children[1].textContent).toBe('mobile.climbRow.setAngleMarker');

      // Your grade takes the column, and the marker goes to the detail line.
      live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
      act(() => setLogbook({ 'c1:40': [sent] }));

      expect(linesOf(container)).toEqual([
        'name',
        'footnote:mobile.climbRow.setAngleMarker · V4 · 12 sends · 4.5★ · setterx',
      ]);
      expect(gradeColumn()?.children).toHaveLength(2);
      const held = gradeColumn()?.children[1];
      expect(held?.textContent).toBe(BLANK);
      expect(held?.getAttribute('data-variant')).toBe('caption2');
      // The marker's own style, so the line it holds is the marker's line.
      expect(styleOf(held)).toEqual({ fontWeight: '600', fontVariant: ['tabular-nums'], marginTop: -2 });
      expect(held?.getAttribute('data-silent')).toBe('true');
    });

    it('holds no such line on a row read at the angle on the wall, or beside a thumbnail', () => {
      live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
      const gradeColumnOf = (container: HTMLElement) =>
        container.querySelector('[data-variant="title3"]')?.parentElement?.parentElement;

      const sameAngle = render(<ClimbListItemContent climb={climb} {...kilter} display={textOnly} />);
      const withThumbnail = render(<ClimbListItemContent climb={{ ...climb, statsAngle: 45 }} {...kilter} />);

      expect(gradeColumnOf(sameAngle.container)?.children).toHaveLength(1);
      expect(gradeColumnOf(withThumbnail.container)?.children).toHaveLength(1);
    });
  });
});

describe('what a row subscribes to follows its switches', () => {
  const subscribers = () => ({ stats: live.stats.listeners.size, logbook: live.logbook.listeners.size });

  it('reads the stats store twice and the logbook four times by default: detail line, grade, and the status glyph', () => {
    render(<ClimbListItemContent climb={climb} {...kilter} />);

    // Stats: the detail line and the grade. Logbook: the glyph's two reads, the
    // grade, and the detail line's token.
    expect(subscribers()).toEqual({ stats: 2, logbook: 4 });
  });

  it.each([
    // The line shows the setter alone: nothing on it comes from the stats store.
    { off: ['sends', 'rating', 'communityGrade'], stats: 1, logbook: 3 },
    // Either number on the line needs the store.
    { off: ['sends', 'communityGrade'], stats: 2, logbook: 3 },
    { off: ['rating', 'communityGrade'], stats: 2, logbook: 3 },
    // The token is worked out from the community's live difficulty.
    { off: ['sends', 'rating'], stats: 2, logbook: 4 },
    // No detail line: the docked token still needs both.
    { off: ['sends', 'rating', 'setter'], stats: 2, logbook: 4 },
    // No detail line and no token: no detail leaf at all.
    { off: ['sends', 'rating', 'setter', 'communityGrade'], stats: 1, logbook: 3 },
    // The glyph is the logbook's other reader.
    { off: ['sentMark'], stats: 2, logbook: 2 },
    { off: ['sentMark', 'communityGrade'], stats: 2, logbook: 1 },
  ] as const)('$off off: $stats stats readers, $logbook logbook readers', ({ off, stats, logbook }) => {
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, ...Object.fromEntries(off.map((fieldId) => [fieldId, false])) };

    render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

    expect(subscribers()).toEqual({ stats, logbook });
  });

  it('works no token out, and reads no store for one, where the column can only show the community grade', () => {
    live.personalGrades = false;
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false };

    render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

    // The setter-only line is plain text; the grade leaf is the one stats reader.
    expect(live.stats.listeners.size).toBe(1);
  });

  it('moves the set-angle marker with the climber’s grade without reading the stats store for it', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, communityGrade: false };

    const { container } = render(
      <ClimbListItemContent climb={{ ...climb, statsAngle: 45 }} {...kilter} display={display} />,
    );

    // The marker's place needs the logbook (whose grade is in the column) and
    // nothing from the stats store: the grade leaf stays its one reader.
    expect(linesOf(container)).toEqual(['name', 'footnote:mobile.climbRow.setAngleMarker · setterx']);
    expect(subscribers()).toEqual({ stats: 1, logbook: 4 });
  });

  it('drops a leaf’s subscription the moment its switch goes off', () => {
    render(<ClimbListItemContent climb={climb} {...kilter} />);
    expect(subscribers()).toEqual({ stats: 2, logbook: 4 });

    act(() => {
      for (const fieldId of ['sends', 'rating', 'setter', 'communityGrade', 'sentMark'] as const) {
        setClimbRowField(fieldId, false);
      }
    });

    // Only the grade is left, which no switch removes.
    expect(subscribers()).toEqual({ stats: 1, logbook: 1 });
  });

  it('reads no playlist memberships until tags are on, on the surface that shows them', () => {
    const read = vi.spyOn(playlistMembershipStore, 'getMembershipsForClimb');

    const off = render(<ClimbListItemContent climb={climb} {...kilter} showPlaylistChips />);
    expect(read).not.toHaveBeenCalled();
    off.unmount();

    render(
      <ClimbListItemContent
        climb={climb}
        {...kilter}
        showPlaylistChips
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true }}
      />,
    );
    expect(read).toHaveBeenCalledWith('c1');
    read.mockRestore();
  });
});

describe('what a screen reader hears follows what is drawn', () => {
  it('speaks only the tokens the detail line draws', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, setter: false };

    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

    const detail = container.querySelector('[data-variant="footnote"]');
    expect(detail?.textContent).toBe('V4 · 4.5★');
    expect(detail?.getAttribute('aria-label')).toBe('mobile.climbRow.communityGradeAria · 4.5★');
  });

  it('says whose grade the docked token is', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

    const { container } = render(<ClimbListItemContent climb={climb} {...kilter} display={display} />);

    expect(container.querySelector('[data-variant="footnote"]')?.getAttribute('aria-label')).toBe(
      'mobile.climbRow.communityGradeAria',
    );
  });

  it('announces nothing for a switched-off element: no label is left behind', () => {
    loadTheRow();
    store(ALL_OFF);

    const { container } = render(
      <ClimbListRow
        climb={climb as unknown as Climb}
        {...kilter}
        onOpenActions={vi.fn()}
        showPlaylistChips
        showFavorite
        showMoreButton
      />,
    );

    // The heart is the one optional glyph with no switch.
    expect([...container.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label'))).toEqual([
      'mobile.climbRow.favorited',
    ]);
    expect(container.textContent).toBe('Boulder ProblemV10');
  });

  it('keeps every line that only holds space silent', () => {
    const display = { ...ALL_ON, thumbnail: false, communityGrade: false };

    const { container } = render(
      <ClimbListItemContent
        climb={{ ...bareClimb, statsAngle: 45 }}
        {...tension}
        display={{ ...display, sends: false }}
        showPlaylistChips
      />,
    );

    const blanks = [...container.querySelectorAll('[data-variant]')].filter((node) => node.textContent === BLANK);
    // The empty detail line, the personal line and the tags line.
    expect(blanks).toHaveLength(3);
    for (const blank of blanks) {
      expect(blank.closest('[data-silent="true"]')).not.toBeNull();
    }
  });

  it('keeps "more actions" published on the row when the ⋮ button is hidden', () => {
    const { container, queryByTestId } = render(
      <ClimbListRow climb={climb as unknown as Climb} {...kilter} onOpenActions={vi.fn()} showMoreButton />,
    );
    expect(queryByTestId('climb-row-more-button')).not.toBeNull();

    act(() => setClimbRowField('quickActions', false));

    expect(queryByTestId('climb-row-more-button')).toBeNull();
    expect(container.querySelector('[data-testid="climb-row"]')?.getAttribute('data-actions')).toContain('moreActions');
  });
});

describe('the Climbs list row around a row without a thumbnail', () => {
  const drawRow = (props: Partial<Parameters<typeof ClimbListRow>[0]> = {}) =>
    render(
      <ClimbListRow climb={climb as unknown as Climb} {...kilter} onOpenActions={vi.fn()} showMoreButton {...props} />,
    );
  const separatorOf = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-style]')].map(styleOf).find((style) => style.height === 0.5);

  it('starts the separator at the gutter, under the text', () => {
    const { container } = drawRow();
    expect(separatorOf(container)?.marginLeft).toBe(104);

    act(() => setClimbRowField('thumbnail', false));

    expect(separatorOf(container)?.marginLeft).toBe(16);
  });

  it('lets the ⋮ button reach into the row’s padding instead of making the row taller, and only then', () => {
    const { getByTestId } = drawRow();
    expect(styleOf(getByTestId('climb-row-more-button'))).toEqual({
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginEnd: -12,
    });

    act(() => setClimbRowField('thumbnail', false));

    // Still a 44pt target; it no longer adds its height to the row's 8pt padding.
    expect(styleOf(getByTestId('climb-row-more-button'))).toEqual({
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginEnd: -12,
      marginVertical: -8,
    });
  });

  it('keeps the geometry of a row with a thumbnail around content a host draws itself', () => {
    store({ ...DEFAULT_CLIMB_ROW_DISPLAY, thumbnail: false });

    const { container, getByTestId } = drawRow({ renderContent: () => <div data-testid="own-content" /> });

    expect(separatorOf(container)?.marginLeft).toBe(104);
    expect(styleOf(getByTestId('climb-row-more-button')).marginVertical).toBeUndefined();
  });
});
