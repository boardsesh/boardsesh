// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The one dependency under test: the row renders exactly the label + colour that
// `resolveGrade` returns (the app-wide "Show Boardsesh grades" swap), instead of
// computing the legacy grade colour itself. A controllable stub lets us assert the
// wiring without the flag/preference plumbing (covered by use-display-grade's tests).
const resolveGrade = vi.fn();
const liveStatsOverride = vi.hoisted(() => ({
  current: null as null | {
    ascensionistCount: number;
    qualityAverage: string | null;
    difficulty: string | null;
  },
}));

// The climber's own grade for the rendered climb. Defaults to 'unknown' — the
// pre-fetch state, which must render exactly like a climb nobody graded — so
// every existing crowd-grade assertion below stays a test of the crowd path.
const myGradeOverride = vi.hoisted(() => ({
  current: { status: 'unknown' } as
    | { status: 'unknown' }
    | { status: 'none' }
    | { status: 'set'; difficultyId: number; climbedAt: string | null },
}));

type StatusEntry = {
  status?: 'flash' | 'send' | 'attempt' | null;
  is_ascent: boolean;
  tries: number;
  is_mirror: boolean;
};
const statusLogbook = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  current: null as { logbookByClimbAngle: Map<string, StatusEntry[]> } | null,
}));

vi.mock('@boardsesh/board-react', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useOptionalBoardLogbook: () =>
      useSyncExternalStore(
        (listener) => {
          statusLogbook.listeners.add(listener);
          return () => {
            statusLogbook.listeners.delete(listener);
          };
        },
        () => statusLogbook.current,
      ),
    logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
    useEffectiveClimbStats: (
      _boardName: string,
      _layoutId: number,
      _climbUuid: string,
      _angle: number,
      base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
    ) =>
      liveStatsOverride.current ?? {
        ascensionistCount: base.ascensionistCount ?? 0,
        qualityAverage: base.qualityAverage ?? null,
        difficulty: base.difficulty ?? null,
      },
  };
});

vi.mock('react-native', () => ({
  // The row asks `climb-row-layout` for its structure, which reads the spacing
  // tokens; `theme/tokens` reaches `ios-colors`, which calls these at module load.
  useWindowDimensions: () => ({ fontScale: 1 }),
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({
    children,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    style?: unknown;
  }) =>
    createElement(
      'div',
      {
        'aria-label': accessibilityLabel,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { direction?: string; status?: string; grade?: string }) => {
      if (key === 'mobile.climbRow.directionStatus' && options) return `${options.direction}: ${options.status}`;
      if (key === 'mobile.climbRow.communityGradeAria' && options) return `Community grade ${options.grade}`;
      return key;
    },
  }),
}));

// The two app-wide grade settings. Both on by default, so every test below can
// put the climber's own grade or a Boardsesh grade in the column; the tests of
// what a row costs turn them off.
const gradeSettings = vi.hoisted(() => ({ personalGrades: true, boardseshGrades: true }));

vi.mock('../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => gradeSettings.boardseshGrades,
  useDisplayGrade: () => ({ boardseshActive: gradeSettings.boardseshGrades, resolveGrade }),
}));

vi.mock('../../hooks/use-personal-grades', () => ({
  usePersonalGradesActive: () => gradeSettings.personalGrades,
}));

const useMyGradeCalls = vi.hoisted(() => [] as Array<{ climbUuid: string; angle: number; options: unknown }>);

// Like the real hook, the stub reads the logbook, so every mounted caller is one
// listener on `statusLogbook` and the tests can count the row's subscribers. And
// like the real hook it reports no grade while personal grades are inactive,
// still subscribed.
vi.mock('../../hooks/use-my-grade', async () => {
  const { useOptionalBoardLogbook } = await import('@boardsesh/board-react');
  return {
    useMyGrade: (climbUuid: string, angle: number, options: unknown) => {
      useOptionalBoardLogbook();
      useMyGradeCalls.push({ climbUuid, angle, options });
      return gradeSettings.personalGrades ? myGradeOverride.current : { status: 'none' };
    },
  };
});

const gradeFormatOverride = vi.hoisted(() => ({ current: 'v-grade' as 'v-grade' | 'font' | 'both' }));
vi.mock('../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: gradeFormatOverride.current }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    textStyles: { body: { lineHeight: 22 } },
    systemColors: { secondaryLabel: '#8E8E93' },
    actionColors: { favorite: '#FF3B30' },
  }),
}));

vi.mock('../../lib/format-climb-stats', () => ({
  formatSends: () => 'sends',
  formatQuality: () => '4.5',
}));

// Text → a span carrying its variant + flattened style colour, so we can find the
// grade (the only variant="title3") and read the colour applied to it.
vi.mock('../Text', () => ({
  Text: ({
    children,
    style,
    variant,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    variant?: string;
    accessibilityLabel?: string;
  }) => {
    const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
    return createElement(
      'span',
      {
        'data-variant': variant,
        'data-color': (flattened as { color?: string }).color,
        'aria-label': accessibilityLabel,
      },
      children,
    );
  },
}));

const thumbnailRender = vi.hoisted(() => vi.fn(() => null));
vi.mock('../ClimbListThumbnail', () => ({
  ClimbListThumbnail: thumbnailRender,
  THUMBNAIL_WIDTH: 60,
  THUMBNAIL_HEIGHT: 80,
}));

// Icons render as a marker span so tests can assert WHICH glyph appeared,
// without pulling in the real SF-Symbol / vector-icon stack. Two features lean
// on that: the favourite heart, and the personal-grade provenance markers (one
// head = your grade, two heads = the crowd's), where glyph SHAPE rather than
// colour is what carries the meaning.
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../ClimbPlaylistChips', () => ({ ClimbPlaylistChips: () => null }));

import { favoritesStore } from '@boardsesh/climb-actions';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../lib/climb-row-display';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../lib/climb-row-display-preference';

const baseClimb = {
  uuid: 'c1',
  name: 'Test Climb',
  frames: 'p1r1',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 10,
  boardseshDifficulty: 20,
  boardseshConfidence: 'confirmed',
};

const gradeNode = (container: HTMLElement) => container.querySelector('[data-variant="title3"]');

// The grade column holds one grade. A second, smaller line under it is where the
// crowd's grade used to sit; nothing may come back there.
const secondGradeLine = (container: HTMLElement) => container.querySelector('[data-variant="caption2"]');
// The line under the name: community grade · sends · quality★ · setter.
const detailLine = (container: HTMLElement) => container.querySelector('[data-variant="footnote"]');
const iconNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-icon]')].map((node) => node.getAttribute('data-icon'));

const renderRow = () =>
  render(<ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />);

describe('ClimbListItemContent grade', () => {
  beforeEach(() => {
    resolveGrade.mockReset();
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
  });

  it('renders the label + colour resolveGrade returns (Boardsesh grade when active)', () => {
    resolveGrade.mockReturnValue({ label: 'V5', color: '#abcdef', isBoardsesh: true });
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );
    const node = gradeNode(container);
    expect(node?.textContent).toBe('V5');
    expect(node?.getAttribute('data-color')).toBe('#abcdef');
  });

  it('falls back to the legacy label + colour resolveGrade returns', () => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );
    const node = gradeNode(container);
    expect(node?.textContent).toBe('V4');
    expect(node?.getAttribute('data-color')).toBe('#111111');
  });

  it('passes the climb (with its Boardsesh grade fields) to resolveGrade', () => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    render(<ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />);
    expect(resolveGrade).toHaveBeenCalledWith(
      expect.objectContaining({ difficulty: '6b/V4', boardseshDifficulty: 20, boardseshConfidence: 'confirmed' }),
      'kilter',
    );
  });

  it('does not resurrect stale quality or difficulty after canonical stats clear them', () => {
    liveStatsOverride.current = {
      ascensionistCount: 10,
      qualityAverage: null,
      difficulty: null,
    };
    resolveGrade.mockReturnValue({ label: '', color: '#111111', isBoardsesh: false });

    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );

    expect(resolveGrade).toHaveBeenCalledWith(expect.objectContaining({ difficulty: null }), 'kilter');
    expect(container.textContent).not.toContain('4.5★');
  });
});

// #5532: a climb pulled in from another angle shows the grade/sends it carries,
// but the row said nothing about where they came from beyond an a11y-only label.
describe('ClimbListItemContent set-angle marker', () => {
  const MY_V10 = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' } as const;
  // The marker as a line of its own under the grade, and the labelled node it
  // is drawn in wherever it sits.
  const markerUnderGrade = (container: HTMLElement) => container.querySelector('[data-variant="caption2"]');
  const renderCrossAngle = (props: { display?: typeof DEFAULT_CLIMB_ROW_DISPLAY; subtitle?: string | null } = {}) =>
    render(
      <ClimbListItemContent
        climb={{ ...baseClimb, statsAngle: 45 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        showAscentStatus={false}
        display={props.display}
        primarySubtitleOverride={props.subtitle}
      />,
    );

  beforeEach(() => {
    resolveGrade.mockReset();
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    resetClimbRowDisplayForTests();
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
    gradeSettings.personalGrades = true;
    gradeSettings.boardseshGrades = true;
    statusLogbook.current = null;
  });

  it('marks a climb whose stats came from a different angle than the one browsed', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, statsAngle: 45 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(container.textContent).toContain('mobile.climbRow.setAngleMarker');
  });

  // The marker says the COMMUNITY's numbers were read at another angle, so it
  // sits with whichever of them the row shows.
  it('sits under the grade while the column shows the community grade', () => {
    const { container } = renderCrossAngle();

    expect(markerUnderGrade(container)?.textContent).toBe('mobile.climbRow.setAngleMarker');
    expect(markerUnderGrade(container)?.getAttribute('aria-label')).toBe('mobile.climbRow.setAngleMarkerAria');
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(detailLine(container)?.hasAttribute('aria-label')).toBe(false);
  });

  it('sits under the grade while the column shows a Boardsesh grade', () => {
    resolveGrade.mockReturnValue({ label: '≈V5', color: '#abcdef', isBoardsesh: true, isEstimated: true });
    const { container } = renderCrossAngle();

    expect(markerUnderGrade(container)?.textContent).toBe('mobile.climbRow.setAngleMarker');
    expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
  });

  it('leads the detail line once the column shows your own grade, which was logged at this angle', () => {
    myGradeOverride.current = MY_V10;
    const { container } = renderCrossAngle();

    expect(gradeNode(container)?.textContent).toBe('V10');
    // Nothing under your grade says it came from 45°.
    expect(markerUnderGrade(container)).toBeNull();
    // In front, so a line cut short at its end still carries it.
    expect(detailLine(container)?.textContent).toBe('mobile.climbRow.setAngleMarker · V4 · sends · 4.5★');
    expect(detailLine(container)?.getAttribute('aria-label')).toBe(
      'mobile.climbRow.setAngleMarkerAria · Community grade V4 · sends · 4.5★',
    );
    expect(container.textContent?.split('mobile.climbRow.setAngleMarker')).toHaveLength(2);
  });

  it('moves to the detail line with the community grade switched off too', () => {
    myGradeOverride.current = MY_V10;
    const { container } = renderCrossAngle({ display: { ...DEFAULT_CLIMB_ROW_DISPLAY, communityGrade: false } });

    expect(markerUnderGrade(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('mobile.climbRow.setAngleMarker · sends · 4.5★');
    expect(detailLine(container)?.getAttribute('aria-label')).toBe('mobile.climbRow.setAngleMarkerAria · sends · 4.5★');
  });

  it('moves with your grade when it reads the same as the community’s and draws no token', () => {
    myGradeOverride.current = { status: 'set', difficultyId: 18, climbedAt: null };
    const { container } = renderCrossAngle();

    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(markerUnderGrade(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('mobile.climbRow.setAngleMarker · sends · 4.5★');
  });

  it.each([
    ['replaces the detail line', 'Sam'],
    ['hides the detail line', null],
  ])('stays under your grade on a host that %s, where it has nowhere else to go', (_label, subtitle) => {
    myGradeOverride.current = MY_V10;
    const { container } = renderCrossAngle({ subtitle });

    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(markerUnderGrade(container)?.textContent).toBe('mobile.climbRow.setAngleMarker');
  });

  it('moves from under the grade to the detail line when your tick lands', () => {
    myGradeOverride.current = { status: 'none' };
    const { container } = renderCrossAngle();
    expect(markerUnderGrade(container)).not.toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');

    act(() => {
      myGradeOverride.current = MY_V10;
      statusLogbook.current = { logbookByClimbAngle: new Map() };
      statusLogbook.listeners.forEach((listener) => listener());
    });

    expect(markerUnderGrade(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('mobile.climbRow.setAngleMarker · V4 · sends · 4.5★');
  });

  it('stays under the grade for a climber with personal grades off, with no logbook read for it', () => {
    gradeSettings.personalGrades = false;
    gradeSettings.boardseshGrades = false;
    const { container } = renderCrossAngle();

    expect(markerUnderGrade(container)?.textContent).toBe('mobile.climbRow.setAngleMarker');
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    // The grade column's subscriber, and none for the detail line.
    expect(statusLogbook.listeners.size).toBe(1);
  });

  it('stands alone in the detail line rather than giving way to "Project"', () => {
    myGradeOverride.current = MY_V10;
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, statsAngle: 45, ascensionist_count: 0, quality_average: '0', setter_username: '' }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );

    expect(detailLine(container)?.textContent).toBe('mobile.climbRow.setAngleMarker');
  });

  it('leaves a climb unmarked when its stats angle matches the browsed angle', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, statsAngle: 40 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(container.textContent).not.toContain('mobile.climbRow.setAngleMarker');
  });

  it('leaves a queue row without the field unmarked rather than guessing', () => {
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );
    expect(container.textContent).not.toContain('mobile.climbRow.setAngleMarker');
  });
});

describe('ClimbListItemContent favourite heart', () => {
  beforeEach(() => {
    favoritesStore.reset();
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });

  const heart = (container: HTMLElement) => container.querySelector('[data-icon="favorite.fill"]');

  it('renders a filled heart in the same neutral grey as the ascent-status glyph', () => {
    favoritesStore.setIsFavorited('c1', true);
    const { container } = render(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        showFavorite
      />,
    );
    // Matches AscentStatusGlyph: this cluster means by shape, not colour.
    expect(heart(container)?.getAttribute('data-color')).toBe('#8E8E93');
  });

  it('renders no heart for a climb that is not favorited', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        showFavorite
      />,
    );
    expect(heart(container)).toBeNull();
  });

  it('stays hidden on surfaces that do not opt in, even when the climb is favorited', () => {
    favoritesStore.setIsFavorited('c1', true);
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );
    expect(heart(container)).toBeNull();
  });
});

describe('ClimbListItemContent hidden chip', () => {
  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });

  const chipIcon = (container: HTMLElement) => container.querySelector('[data-icon="visibility.off"]');

  it('marks a community-hidden climb, since it still shows in a name search', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, is_hidden: true }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(chipIcon(container)).not.toBeNull();
    expect(container.textContent).toContain('mobile.hidden.chip');
  });

  it('leaves a visible climb unmarked', () => {
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
    );
    expect(chipIcon(container)).toBeNull();
  });

  it('leaves a queue row without the field unmarked rather than guessing', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, is_hidden: null }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(chipIcon(container)).toBeNull();
  });
});

// #4796 / #4828: the grade a climber gave a climb wins over the crowd's, and
// the crowd's moves to the front of the detail line — but only where they disagree.
describe('ClimbListItemContent personal grade', () => {
  beforeEach(() => {
    resolveGrade.mockReset();
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
  });

  it('renders the crowd grade untouched before the logbook has been fetched', () => {
    // State E. An empty bucket is ambiguous until the fetch lands, so the row
    // must look exactly like one nobody graded rather than guess (#3940).
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    const { container } = renderRow();
    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(secondGradeLine(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(iconNames(container)).not.toContain('person');
  });

  it('renders the crowd grade untouched when the climber never graded it', () => {
    // State A — the common case, and byte-identical to today's row.
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'none' };
    const { container } = renderRow();
    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(secondGradeLine(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(iconNames(container)).not.toContain('person');
  });

  // Offline the logbook never resolves, so the row's own projected grade is the
  // only thing that keeps its label in step with the band the search put it in.
  it('hands the search row’s own grade to useMyGrade, and never asks for a local read', () => {
    useMyGradeCalls.length = 0;
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    render(
      <ClimbListItemContent
        climb={{ ...baseClimb, myDifficulty: 27 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(useMyGradeCalls.at(-1)).toEqual({ climbUuid: baseClimb.uuid, angle: 40, options: { rowDifficulty: 27 } });
  });

  it('shows your grade, marked, with the crowd’s at the front of the detail line when they disagree', () => {
    // State C — the Woods case in both issues: set at V0, you called it V10.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(detailLine(container)?.textContent).toBe('V0 · sends · 4.5★');
    // One grade in the column: the crowd's no longer stacks under yours, and the
    // glyph that marked it there is gone with it.
    expect(secondGradeLine(container)).toBeNull();
    expect(iconNames(container)).toContain('person');
    expect(iconNames(container)).not.toContain('people');
  });

  it('colours the big number by YOUR grade, not the crowd’s', () => {
    // The colour has to follow the number actually shown, or a V10 reads in
    // the V0 colour and the row lies twice over.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();
    expect(gradeNode(container)?.getAttribute('data-color')).not.toBe('#111111');
  });

  it('stays silent when your grade and the crowd’s render to the same label', () => {
    // State B, and the reason equality is compared on the LABEL rather than the
    // difficulty id: ids 10/11/12 are 4a, 4b and 4c, three distinct grades that
    // all render "V0". A climber who logged 4c on a climb listed as 4a has not
    // disagreed with anything a reader can see, so "V0 over V0" would be noise.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 12, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V0');
    expect(secondGradeLine(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(iconNames(container)).not.toContain('person');
  });

  it('marks your grade with no crowd grade anywhere when there is no crowd number', () => {
    // State D — a draft, or an angle with no stats row.
    resolveGrade.mockReturnValue({ label: '', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(secondGradeLine(container)).toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(iconNames(container)).toContain('person');
  });
});

// The community's grade leads the detail line when the grade column shows a
// different one. It is the row's only second grade: the column never stacks.
describe('ClimbListItemContent community grade token', () => {
  const MY_V10 = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' } as const;
  const communityGradeOff = { ...DEFAULT_CLIMB_ROW_DISPLAY, communityGrade: false };

  beforeEach(() => {
    resolveGrade.mockReset();
    resetClimbRowDisplayForTests();
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
    gradeFormatOverride.current = 'v-grade';
    gradeSettings.personalGrades = true;
    gradeSettings.boardseshGrades = true;
    statusLogbook.current = null;
  });

  afterEach(() => {
    resetClimbRowDisplayForTests();
    gradeFormatOverride.current = 'v-grade';
    gradeSettings.personalGrades = true;
    gradeSettings.boardseshGrades = true;
  });

  it('tells a screen reader whose grade the token is', () => {
    // On screen the token is a bare "V0". Spoken, the line names it; the rest of
    // the line reads as it always did.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = MY_V10;
    const { container } = renderRow();

    expect(detailLine(container)?.textContent).toBe('V0 · sends · 4.5★');
    expect(detailLine(container)?.getAttribute('aria-label')).toBe('Community grade V0 · sends · 4.5★');
  });

  it('leaves the detail line unlabelled when there is no token to explain', () => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    const { container } = renderRow();

    expect(detailLine(container)?.hasAttribute('aria-label')).toBe(false);
  });

  it('draws the token in the detail line’s own style, uncoloured', () => {
    // In this row colour means the big grade and nothing else.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = MY_V10;
    const { container } = renderRow();

    expect(container.querySelectorAll('[data-variant="footnote"]')).toHaveLength(1);
    expect(detailLine(container)?.hasAttribute('data-color')).toBe(false);
  });

  it('shows no token when the climber turned the community grade off', () => {
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = MY_V10;
    const { container } = render(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        display={communityGradeOff}
      />,
    );

    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(detailLine(container)?.hasAttribute('aria-label')).toBe(false);
    // The column is not the switch's business: your grade and its mark stay.
    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(iconNames(container)).toContain('person');
    expect(secondGradeLine(container)).toBeNull();
  });

  it('follows the stored switch live, with no prop from the host', () => {
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = MY_V10;
    const { container } = renderRow();
    expect(detailLine(container)?.textContent).toBe('V0 · sends · 4.5★');

    act(() => setClimbRowField('communityGrade', false));
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');

    act(() => setClimbRowField('communityGrade', true));
    expect(detailLine(container)?.textContent).toBe('V0 · sends · 4.5★');
  });

  it('shows the community grade beside an active Boardsesh grade that reads differently', () => {
    // The stub stands in for an active Boardsesh grade; the token is the plain
    // community grade for the same climb, "6b/V4".
    resolveGrade.mockReturnValue({ label: '≈V5', color: '#abcdef', isBoardsesh: true, isEstimated: true });
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('≈V5');
    expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
    expect(detailLine(container)?.getAttribute('aria-label')).toBe('Community grade V4 · sends · 4.5★');
    // Not the climber's own grade, so no mark.
    expect(iconNames(container)).not.toContain('person');
  });

  it('shows no token when the Boardsesh grade reads the same apart from the estimate mark', () => {
    resolveGrade.mockReturnValue({ label: '≈V4', color: '#abcdef', isBoardsesh: true, isEstimated: true });
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('≈V4');
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
  });

  it('shows no token when the Boardsesh grade and the community’s are the same', () => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#abcdef', isBoardsesh: true, isEstimated: false });
    const { container } = renderRow();

    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
  });

  // Both settings on. The token is always the community's grade, so the row
  // shows yours and the community's; the Boardsesh grade is in the play drawer.
  it('shows the community grade, never the Boardsesh grade, beside your own with Boardsesh grades on', () => {
    // Mine V4, Boardsesh V6, community V5.
    resolveGrade.mockReturnValue({ label: 'V6', color: '#abcdef', isBoardsesh: true, isEstimated: false });
    myGradeOverride.current = { status: 'set', difficultyId: 18, climbedAt: null };
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, difficulty: '6c/V5' }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );

    expect(gradeNode(container)?.textContent).toBe('V4');
    // Marked: it is not the V6 this row would otherwise show.
    expect(iconNames(container)).toContain('person');
    expect(detailLine(container)?.textContent).toBe('V5 · sends · 4.5★');
    expect(detailLine(container)?.getAttribute('aria-label')).toBe('Community grade V5 · sends · 4.5★');
    expect(container.textContent).not.toContain('V6');
    expect(secondGradeLine(container)).toBeNull();
  });

  it('marks your grade with no token when it agrees with the community but not with Boardsesh', () => {
    // Mine V4, Boardsesh V5, community V4.
    resolveGrade.mockReturnValue({ label: 'V5', color: '#abcdef', isBoardsesh: true, isEstimated: false });
    myGradeOverride.current = { status: 'set', difficultyId: 18, climbedAt: null };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(iconNames(container)).toContain('person');
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
  });

  it('leaves your grade unmarked beside a Boardsesh estimate of the same number', () => {
    // Mine V5, Boardsesh ≈V5, community V4.
    resolveGrade.mockReturnValue({ label: '≈V5', color: '#abcdef', isBoardsesh: true, isEstimated: true });
    myGradeOverride.current = { status: 'set', difficultyId: 20, climbedAt: null };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V5');
    expect(iconNames(container)).not.toContain('person');
    expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
  });

  it('reads the community grade from the live stats, not the stale row', () => {
    // The stats store moved the climb to V5 after the list fetched it as V4.
    liveStatsOverride.current = { ascensionistCount: 10, qualityAverage: '4.5', difficulty: '6c/V5' };
    resolveGrade.mockReturnValue({ label: 'V7', color: '#abcdef', isBoardsesh: true, isEstimated: false });
    const { container } = renderRow();

    expect(detailLine(container)?.textContent).toBe('V5 · sends · 4.5★');
  });

  it('formats the community grade on the climb’s own board scale', () => {
    // "6a+/V3" is "V3+" on the shared scale, where V3 covers two Font grades, and
    // plain "V3" on MoonBoard, where it covers one.
    resolveGrade.mockReturnValue({ label: 'V7', color: '#abcdef', isBoardsesh: true, isEstimated: false });
    const renderOn = (boardName: 'kilter' | 'moonboard') =>
      render(
        <ClimbListItemContent
          climb={{ ...baseClimb, difficulty: '6a+/V3' }}
          boardName={boardName}
          layoutId={1}
          sizeId={1}
          setIds="1"
          angle={40}
        />,
      );

    const kilter = renderOn('kilter');
    expect(detailLine(kilter.container)?.textContent).toBe('V3+ · sends · 4.5★');
    kilter.unmount();
    expect(detailLine(renderOn('moonboard').container)?.textContent).toBe('V3 · sends · 4.5★');
  });

  describe('under the both-systems grade format', () => {
    beforeEach(() => {
      gradeFormatOverride.current = 'both';
    });

    it('shows only the V half of the community grade beside your own', () => {
      resolveGrade.mockReturnValue({ label: 'V4 / 6B', color: '#111111', isBoardsesh: false });
      myGradeOverride.current = MY_V10;
      const { container } = renderRow();

      expect(gradeNode(container)?.textContent).toBe('V10 / 7C+');
      expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
      expect(detailLine(container)?.getAttribute('aria-label')).toBe('Community grade V4 · sends · 4.5★');
    });

    it('shows only the V half beside a Boardsesh grade', () => {
      resolveGrade.mockReturnValue({ label: '≈V5 / 6C', color: '#abcdef', isBoardsesh: true, isEstimated: true });
      const { container } = renderRow();

      expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
    });

    it('shows no token when the two whole labels read the same', () => {
      resolveGrade.mockReturnValue({ label: '≈V4 / 6B', color: '#abcdef', isBoardsesh: true, isEstimated: true });
      const { container } = renderRow();

      expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    });

    it('suppresses the token when only the Font half differs', () => {
      // Yours 4c against the community's 4a: both are V0.
      resolveGrade.mockReturnValue({ label: 'V0 / 4A', color: '#111111', isBoardsesh: false });
      myGradeOverride.current = { status: 'set', difficultyId: 12, climbedAt: null };
      const { container } = renderRow();

      expect(gradeNode(container)?.textContent).toBe('V0 / 4C');
      expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
      expect(detailLine(container)?.getAttribute('aria-label')).toBeNull();
    });

    it('suppresses the token beside a Boardsesh grade on the same V grade', () => {
      // Boardsesh 6b+ against the community's 6b: both are V4.
      resolveGrade.mockReturnValue({ label: '≈V4 / 6B+', color: '#abcdef', isBoardsesh: true, isEstimated: true });
      const { container } = renderRow();

      expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    });
  });

  it('shows no token on a Project', () => {
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, difficulty: '', boardseshDifficulty: null }}
        boardName="spray"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );

    expect(container.querySelector('[aria-label="mobile.project.chip"]')).not.toBeNull();
    expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
    expect(detailLine(container)?.hasAttribute('aria-label')).toBe(false);
  });

  // A host that replaces or hides the computed detail line has nowhere to put the
  // token. That is the intended outcome for session rows, not an oversight.
  it.each([
    ['replaces the detail line', 'Sam'],
    ['hides the detail line', null],
  ])('shows no token on a host that %s', (_label, primarySubtitleOverride) => {
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = MY_V10;
    const { container } = render(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        showAscentStatus={false}
        primarySubtitleOverride={primarySubtitleOverride}
      />,
    );

    expect(container.textContent).not.toContain('V0');
    expect(container.textContent).not.toContain('Community grade');
    expect(container.querySelector('[aria-label^="Community grade"]')).toBeNull();
    // The column still shows one grade, yours, with its mark.
    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(secondGradeLine(container)).toBeNull();
    expect(iconNames(container)).toContain('person');
    // And the row mounted no detail-line subscriber for a token it cannot show.
    expect(statusLogbook.listeners.size).toBe(1);
  });

  describe('the "Project" fallback', () => {
    const bareClimb = { ...baseClimb, ascensionist_count: 0, quality_average: '0', setter_username: '' };
    const renderBare = () =>
      render(
        <ClimbListItemContent climb={bareClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />,
      );

    it('still reads Project for a climb with no sends, no rating, no setter and no community grade', () => {
      resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
      const { container } = renderBare();

      expect(detailLine(container)?.textContent).toBe('mobile.climbRow.projectFallback');
    });

    it('gives way to the community grade, which is something known about the climb', () => {
      resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
      myGradeOverride.current = MY_V10;
      const { container } = renderBare();

      expect(detailLine(container)?.textContent).toBe('V0');
      expect(detailLine(container)?.getAttribute('aria-label')).toBe('Community grade V0');
    });
  });

  // The logbook rule: subscriptions live in memoised leaves, and the detail line
  // has one only where the climber's own grade can change what it draws.
  describe('logbook subscriptions', () => {
    const renderWithoutStatus = (display = DEFAULT_CLIMB_ROW_DISPLAY) =>
      render(
        <ClimbListItemContent
          climb={baseClimb}
          boardName="kilter"
          layoutId={1}
          sizeId={1}
          setIds="1"
          angle={40}
          showAscentStatus={false}
          display={display}
        />,
      );

    beforeEach(() => {
      resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    });

    it('mounts no logbook subscriber in the detail line while the switch is off', () => {
      renderWithoutStatus(communityGradeOff);

      // The grade column's, and nothing else.
      expect(statusLogbook.listeners.size).toBe(1);
    });

    it('adds exactly one, the detail line’s own, while the switch is on', () => {
      renderWithoutStatus();

      expect(statusLogbook.listeners.size).toBe(2);
    });

    it('drops the detail line’s subscriber the moment the switch goes off', () => {
      render(
        <ClimbListItemContent
          climb={baseClimb}
          boardName="kilter"
          layoutId={1}
          sizeId={1}
          setIds="1"
          angle={40}
          showAscentStatus={false}
        />,
      );
      expect(statusLogbook.listeners.size).toBe(2);

      act(() => setClimbRowField('communityGrade', false));

      expect(statusLogbook.listeners.size).toBe(1);
    });

    it('asks the logbook about the same climb, angle and row grade as the grade column does', () => {
      useMyGradeCalls.length = 0;
      render(
        <ClimbListItemContent
          climb={{ ...baseClimb, myDifficulty: 27 }}
          boardName="kilter"
          layoutId={1}
          sizeId={1}
          setIds="1"
          angle={40}
          showAscentStatus={false}
        />,
      );

      expect(useMyGradeCalls).toEqual([
        { climbUuid: baseClimb.uuid, angle: 40, options: { rowDifficulty: 27 } },
        { climbUuid: baseClimb.uuid, angle: 40, options: { rowDifficulty: 27 } },
      ]);
    });

    // What the detail line works out follows the two grade settings, so a row
    // never pays for a grade it cannot be showing.
    describe('by grade setting', () => {
      it('works out no grade at all with personal and Boardsesh grades both off', () => {
        gradeSettings.personalGrades = false;
        gradeSettings.boardseshGrades = false;
        const { container } = renderWithoutStatus();

        expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
        // One logbook subscriber and one grade lookup: the grade column's.
        expect(statusLogbook.listeners.size).toBe(1);
        expect(resolveGrade).toHaveBeenCalledTimes(1);
      });

      it('works the token out without the logbook with only Boardsesh grades on', () => {
        gradeSettings.personalGrades = false;
        resolveGrade.mockReturnValue({ label: '≈V5', color: '#abcdef', isBoardsesh: true, isEstimated: true });
        useMyGradeCalls.length = 0;
        const { container } = renderWithoutStatus();

        expect(detailLine(container)?.textContent).toBe('V4 · sends · 4.5★');
        expect(statusLogbook.listeners.size).toBe(1);
        expect(useMyGradeCalls).toHaveLength(1);
        // The grade column and the detail line each looked the grade up.
        expect(resolveGrade).toHaveBeenCalledTimes(2);
      });

      it('leaves that detail line alone when a tick lands', () => {
        gradeSettings.personalGrades = false;
        resolveGrade.mockReturnValue({ label: '≈V5', color: '#abcdef', isBoardsesh: true, isEstimated: true });
        renderWithoutStatus();
        resolveGrade.mockClear();

        act(() => {
          statusLogbook.current = { logbookByClimbAngle: new Map() };
          statusLogbook.listeners.forEach((listener) => listener());
        });

        // Only the grade column, the one logbook subscriber, looked again.
        expect(resolveGrade).toHaveBeenCalledTimes(1);
      });

      it('reads the logbook with personal grades on, whether or not Boardsesh grades are', () => {
        gradeSettings.boardseshGrades = false;
        const personalOnly = renderWithoutStatus();
        expect(statusLogbook.listeners.size).toBe(2);
        personalOnly.unmount();

        gradeSettings.boardseshGrades = true;
        renderWithoutStatus();
        expect(statusLogbook.listeners.size).toBe(2);
      });

      it('reads no logbook for the detail line with the token switched off, whatever the settings', () => {
        for (const personalGrades of [true, false]) {
          for (const boardseshGrades of [true, false]) {
            gradeSettings.personalGrades = personalGrades;
            gradeSettings.boardseshGrades = boardseshGrades;
            resolveGrade.mockClear();
            const row = renderWithoutStatus(communityGradeOff);

            expect(statusLogbook.listeners.size).toBe(1);
            expect(resolveGrade).toHaveBeenCalledTimes(1);
            row.unmount();
          }
        }
      });

      // The one reason to read the logbook with the token off: a row read at
      // another angle has a marker whose place follows the climber's own grade.
      it('reads the logbook for a cross-angle row with the token off, to place the set-angle marker', () => {
        const renderCrossAngle = () =>
          render(
            <ClimbListItemContent
              climb={{ ...baseClimb, statsAngle: 45 }}
              boardName="kilter"
              layoutId={1}
              sizeId={1}
              setIds="1"
              angle={40}
              showAscentStatus={false}
              display={communityGradeOff}
            />,
          );

        const withPersonalGrades = renderCrossAngle();
        expect(statusLogbook.listeners.size).toBe(2);
        withPersonalGrades.unmount();

        gradeSettings.personalGrades = false;
        renderCrossAngle();
        expect(statusLogbook.listeners.size).toBe(1);
      });
    });

    it('moves the token and the grade together when a tick lands, without touching the thumbnail', () => {
      resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
      myGradeOverride.current = { status: 'none' };
      thumbnailRender.mockClear();
      const { container } = renderWithoutStatus();
      expect(gradeNode(container)?.textContent).toBe('V0');
      expect(detailLine(container)?.textContent).toBe('sends · 4.5★');
      const thumbnailCalls = thumbnailRender.mock.calls.length;

      act(() => {
        myGradeOverride.current = MY_V10;
        statusLogbook.current = { logbookByClimbAngle: new Map() };
        statusLogbook.listeners.forEach((listener) => listener());
      });

      expect(gradeNode(container)?.textContent).toBe('V10');
      expect(detailLine(container)?.textContent).toBe('V0 · sends · 4.5★');
      expect(thumbnailRender.mock.calls).toHaveLength(thumbnailCalls);
    });
  });
});

// A spray climb that lost a hold is listed like any other, with a badge, so the
// climber knows before tapping in that a hold it names is gone.
describe('ClimbListItemContent lost-holds chip', () => {
  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });

  const chipIcon = (container: HTMLElement) => container.querySelector('[data-icon="frame.remove"]');

  const renderWith = (missingHoldCount: number | null | undefined) =>
    render(
      <ClimbListItemContent
        climb={{ ...baseClimb, missingHoldCount }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );

  it('marks a climb that lost holds', () => {
    const { container } = renderWith(3);
    expect(chipIcon(container)).not.toBeNull();
    expect(container.textContent).toContain('mobile.lostHolds.chip');
  });

  it('keeps all attributes below the name when a climb lost holds', () => {
    const { container, getByText } = render(
      <ClimbListItemContent
        climb={{
          ...baseClimb,
          name: 'A long spray climb name',
          missingHoldCount: 4,
          characteristics: ['any_feet', 'no_match'],
          benchmark_difficulty: '18',
          is_hidden: true,
        }}
        boardName="spray"
        layoutId={1}
        sizeId={1}
        setIds=""
        angle={40}
      />,
    );
    const name = getByText('A long spray climb name');
    const chip = chipIcon(container);
    expect(chip).not.toBeNull();
    expect(name.parentElement?.contains(chip)).toBe(false);
    expect(name.parentElement?.textContent).toBe('A long spray climb name');
    const attributesRow = name.parentElement?.nextElementSibling;
    for (const iconName of ['frame.remove', 'benchmark', 'no.match', 'visibility.off']) {
      const icon = container.querySelector(`[data-icon="${iconName}"]`);
      expect(icon).not.toBeNull();
      expect(attributesRow?.contains(icon)).toBe(true);
    }
    expect(attributesRow?.contains(getByText('mobile.climbRow.anyFeet'))).toBe(true);
    expect(attributesRow?.contains(getByText('mobile.hidden.chip'))).toBe(true);
  });

  it('leaves a climb with every hold still on the wall unmarked', () => {
    // The mutation guard: `> 0`, not `>= 0`. Every climb on every catalogue board
    // reports 0 here, so a relaxed predicate would badge the entire database.
    expect(chipIcon(renderWith(0).container)).toBeNull();
  });

  it('leaves a catalogue-board climb (null) unmarked', () => {
    expect(chipIcon(renderWith(null).container)).toBeNull();
  });

  it('leaves a queue row without the field unmarked rather than guessing', () => {
    expect(chipIcon(renderWith(undefined).container)).toBeNull();
  });

  it('stays in the row neutral grey — colour is the grade’s alone', () => {
    const { container } = renderWith(1);
    expect(chipIcon(container)?.getAttribute('data-color')).toBe('#8E8E93');
  });
});

// #5954: a draft is left out of the Climbs list, so every row that does show one
// (Open drafts, your queue, the actions sheet preview) marks it with a chip.
describe('ClimbListItemContent draft chip', () => {
  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    liveStatsOverride.current = null;
  });

  const chip = (container: HTMLElement) => container.querySelector('[aria-label="createClimbForm.draftBadge"]');

  const renderWith = (isDraft: boolean | null | undefined, primarySubtitleOverride?: string) =>
    render(
      <ClimbListItemContent
        climb={{ ...baseClimb, is_draft: isDraft, setter_username: 'marco' }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        primarySubtitleOverride={primarySubtitleOverride}
      />,
    );

  it('marks a draft', () => {
    const { container } = renderWith(true);
    expect(chip(container)?.textContent).toBe('createClimbForm.draftBadge');
  });

  it('says it once: the subtitle no longer repeats the word', () => {
    const { container } = renderWith(true);
    expect(container.textContent?.split('createClimbForm.draftBadge').length).toBe(2);
    expect(container.textContent).toContain('marco');
  });

  it('still marks a draft whose subtitle a caller replaced', () => {
    // A queue row passes its own subtitle, which used to drop the only draft marker.
    expect(chip(renderWith(true, 'Added by Sam').container)).not.toBeNull();
  });

  it('leaves a published climb unmarked, and one that does not say', () => {
    expect(chip(renderWith(false).container)).toBeNull();
    expect(chip(renderWith(null).container)).toBeNull();
    expect(chip(renderWith(undefined).container)).toBeNull();
  });
});

describe('ClimbListItemContent project chip (#5971)', () => {
  beforeEach(() => {
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
  });

  const chip = (container: HTMLElement) => container.querySelector('[aria-label="mobile.project.chip"]');

  const renderWith = (climb: Record<string, unknown>, boardName: 'spray' | 'kilter' = 'spray') =>
    render(
      <ClimbListItemContent
        climb={{ ...baseClimb, ...climb }}
        boardName={boardName}
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );

  it('puts Project in the grade slot of a published climb nobody has graded', () => {
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    const { container } = renderWith({ difficulty: '', boardseshDifficulty: null });
    expect(chip(container)?.textContent).toBe('mobile.project.chip');
    expect(gradeNode(container)).toBeNull();
  });

  it('shows your own grade instead, once you have graded it', () => {
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderWith({ difficulty: '', boardseshDifficulty: null });
    expect(chip(container)).toBeNull();
    expect(gradeNode(container)?.textContent).not.toBe('');
  });

  it('leaves an offline Kilter row with no stats yet blank, not a project', () => {
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    const offline = renderWith({ difficulty: '', boardseshDifficulty: null, statsAngle: null }, 'kilter');
    expect(chip(offline.container)).toBeNull();
    offline.unmount();
    // Once its stats are known, an ungraded Kilter climb is a project like any other.
    const synced = renderWith({ difficulty: '', boardseshDifficulty: null, statsAngle: 40 }, 'kilter');
    expect(chip(synced.container)?.textContent).toBe('mobile.project.chip');
  });

  it('leaves a graded climb, and an ungraded draft, without it', () => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    expect(chip(renderWith({}).container)).toBeNull();
    resolveGrade.mockReturnValue({ label: '', color: '#000000', isBoardsesh: false });
    expect(chip(renderWith({ difficulty: '', is_draft: true }).container)).toBeNull();
  });
});

// #5917: exercise the actual indexed hook and status precedence, not a glyph stub.
describe('ClimbListItemContent original and mirror statuses', () => {
  const tick = (overrides: Partial<StatusEntry> = {}): StatusEntry => ({
    status: 'send',
    is_ascent: true,
    tries: 2,
    is_mirror: false,
    ...overrides,
  });
  const renderWoods = (angle = 40) =>
    render(
      <ClimbListItemContent climb={baseClimb} boardName="woods" layoutId={1} sizeId={2} setIds="1" angle={angle} />,
    );
  const directionRows = (container: HTMLElement) =>
    [...container.querySelectorAll('[aria-label]')].filter((node) =>
      node.getAttribute('aria-label')?.includes('mobile.logbook.'),
    );

  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    statusLogbook.current = null;
  });

  it.each([false, true])('identifies a single direction send (mirrored=%s)', (isMirror) => {
    statusLogbook.current = { logbookByClimbAngle: new Map([['c1:40', [tick({ is_mirror: isMirror })]]]) };
    const rows = directionRows(renderWoods().container);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe(isMirror ? 'mobile.logbook.mirroredTag' : 'mobile.logbook.originalTag');
    expect(rows[0].getAttribute('aria-label')).toContain('ascentStatus.send');
    expect(rows[0].querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('tick.outline');
  });

  it.each(['woods', 'tension'] as const)('shows both sends independently on %s layout 1', (boardName) => {
    statusLogbook.current = { logbookByClimbAngle: new Map([['c1:40', [tick(), tick({ is_mirror: true })]]]) };
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName={boardName} layoutId={1} sizeId={2} setIds="1" angle={40} />,
    );
    const rows = directionRows(container);
    expect(rows.map((node) => node.textContent)).toEqual(['mobile.logbook.originalTag', 'mobile.logbook.mirroredTag']);
    expect(rows.every((node) => node.getAttribute('aria-label')?.includes('ascentStatus.send'))).toBe(true);
  });

  it('hides both Woods direction statuses while retaining normal climb content', () => {
    myGradeOverride.current = { status: 'unknown' };
    statusLogbook.current = {
      logbookByClimbAngle: new Map([
        [
          'c1:40',
          [tick({ status: 'flash', tries: 1 }), tick({ is_mirror: true, status: 'attempt', is_ascent: false })],
        ],
      ]),
    };
    const { container, rerender } = renderWoods();
    expect(directionRows(container)).toHaveLength(2);
    expect(iconNames(container)).toEqual(expect.arrayContaining(['flash', 'ascent.attempt']));

    rerender(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="woods"
        layoutId={1}
        sizeId={2}
        setIds="1"
        angle={40}
        showAscentStatus={false}
      />,
    );

    expect(directionRows(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('mobile.logbook.originalTag');
    expect(container.textContent).not.toContain('mobile.logbook.mirroredTag');
    expect(iconNames(container)).not.toContain('flash');
    expect(iconNames(container)).not.toContain('ascent.attempt');
    expect(iconNames(container)).not.toContain('tick.outline');
    expect(container.textContent).toContain(baseClimb.name);
    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(container.textContent).toContain('4.5★');
    expect(container.textContent).toContain('sends');
  });

  it('preserves flash precedence in the original direction and a mirrored try', () => {
    statusLogbook.current = {
      logbookByClimbAngle: new Map([
        [
          'c1:40',
          [tick(), tick({ status: null, tries: 1 }), tick({ is_mirror: true, status: 'attempt', is_ascent: false })],
        ],
      ]),
    };
    const rows = directionRows(renderWoods().container);
    expect(rows.map((node) => node.getAttribute('aria-label'))).toEqual([
      'mobile.logbook.originalTag: mobile.climbRow.ascentStatus.flash',
      'mobile.logbook.mirroredTag: mobile.climbRow.ascentStatus.attempt',
    ]);
    expect(rows.map((node) => node.querySelector('[data-icon]')?.getAttribute('data-icon'))).toEqual([
      'flash',
      'ascent.attempt',
    ]);
  });

  it('never claims an original send from a mirrored-only attempt', () => {
    statusLogbook.current = {
      logbookByClimbAngle: new Map([['c1:40', [tick({ is_mirror: true, status: null, is_ascent: false })]]]),
    };
    const rows = directionRows(renderWoods().container);
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('aria-label')).toBe('mobile.logbook.mirroredTag: mobile.climbRow.ascentStatus.attempt');
  });

  it('shows no status outside the provider or at another angle', () => {
    expect(directionRows(renderWoods().container)).toHaveLength(0);
    statusLogbook.current = { logbookByClimbAngle: new Map([['c1:40', [tick()]]]) };
    expect(directionRows(renderWoods(30).container)).toHaveLength(0);
  });

  it('updates only the status child after a logbook merge', () => {
    thumbnailRender.mockClear();
    const { container } = renderWoods();
    expect(directionRows(container)).toHaveLength(0);
    const thumbnailCalls = thumbnailRender.mock.calls.length;
    act(() => {
      statusLogbook.current = { logbookByClimbAngle: new Map([['c1:40', [tick({ is_mirror: true })]]]) };
      statusLogbook.listeners.forEach((listener) => listener());
    });
    expect(directionRows(container)[0]?.textContent).toBe('mobile.logbook.mirroredTag');
    expect(thumbnailRender.mock.calls).toHaveLength(thumbnailCalls);
    expect(container.textContent).toContain(baseClimb.name);
  });

  it('retains a single aggregate glyph for nonmirrorable Tension layout 11', () => {
    statusLogbook.current = { logbookByClimbAngle: new Map([['c1:40', [tick({ is_mirror: true })]]]) };
    const { container } = render(
      <ClimbListItemContent climb={baseClimb} boardName="tension" layoutId={11} sizeId={1} setIds="1" angle={40} />,
    );
    expect(directionRows(container)).toHaveLength(0);
    expect(container.querySelector('[aria-label="mobile.climbRow.ascentStatus.send"]')).not.toBeNull();
  });
});

describe('multi-frame route pips', () => {
  beforeEach(() => {
    resetClimbRowDisplayForTests();
    liveStatsOverride.current = null;
    myGradeOverride.current = { status: 'unknown' };
    statusLogbook.current = null;
    gradeFormatOverride.current = 'v-grade';
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });
  afterEach(() => resetClimbRowDisplayForTests());
  it.each([undefined, null, 1])('adds no frame marker for count %s', (framesCount) => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, framesCount }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    expect(container.querySelector('[data-icon="frames"]')).toBeNull();
  });
  it('overlays the picture without allocating a name-line box', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, framesCount: 4 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    const pip = container.querySelector('[data-icon="frames"]')?.parentElement;
    expect(pip).toBeTruthy();
    expect(pip?.getAttribute('data-style')).toContain('absolute');
  });
  it('moves the marker to the name cluster when pictures are off', () => {
    setClimbRowField('thumbnail', false);
    thumbnailRender.mockClear();
    const { container } = render(
      <ClimbListItemContent
        climb={{ ...baseClimb, framesCount: 4 }}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
      />,
    );
    const pip = container.querySelector('[data-icon="frames"]')?.parentElement;
    expect(pip).toBeTruthy();
    expect(pip?.getAttribute('data-style')).not.toContain('absolute');
    expect(pip?.parentElement?.textContent).toContain(baseClimb.name);
    expect(thumbnailRender).not.toHaveBeenCalled();
  });
});
