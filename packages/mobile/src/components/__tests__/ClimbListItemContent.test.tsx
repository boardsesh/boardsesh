// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { direction: string; status: string }) =>
      key === 'mobile.climbRow.directionStatus' && options ? `${options.direction}: ${options.status}` : key,
  }),
}));

vi.mock('../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ boardseshActive: true, resolveGrade }),
}));

const useMyGradeCalls = vi.hoisted(() => [] as Array<{ climbUuid: string; angle: number; options: unknown }>);

vi.mock('../../hooks/use-my-grade', () => ({
  useMyGrade: (climbUuid: string, angle: number, options: unknown) => {
    useMyGradeCalls.push({ climbUuid, angle, options });
    return myGradeOverride.current;
  },
}));

vi.mock('../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade' }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' }, actionColors: { favorite: '#FF3B30' } }),
}));

vi.mock('../../lib/format-climb-stats', () => ({
  formatSends: () => 'sends',
  formatQuality: () => '4.5',
}));

// Text → a span carrying its variant + flattened style colour, so we can find the
// grade (the only variant="title3") and read the colour applied to it.
vi.mock('../Text', () => ({
  Text: ({ children, style, variant }: { children?: ReactNode; style?: unknown; variant?: string }) => {
    const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
    return createElement(
      'span',
      { 'data-variant': variant, 'data-color': (flattened as { color?: string }).color },
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

const secondaryNode = (container: HTMLElement) => container.querySelector('[data-variant="caption2"]');
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

    expect(resolveGrade).toHaveBeenCalledWith(expect.objectContaining({ difficulty: null }));
    expect(container.textContent).not.toContain('4.5★');
  });
});

// #5532: a climb pulled in from another angle shows the grade/sends it carries,
// but the row said nothing about where they came from beyond an a11y-only label.
describe('ClimbListItemContent set-angle marker', () => {
  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
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
// the crowd's demotes to a marked second line — but only where they disagree.
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
    expect(secondaryNode(container)).toBeNull();
    expect(iconNames(container)).not.toContain('person');
  });

  it('renders the crowd grade untouched when the climber never graded it', () => {
    // State A — the common case, and byte-identical to today's row.
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'none' };
    const { container } = renderRow();
    expect(gradeNode(container)?.textContent).toBe('V4');
    expect(secondaryNode(container)).toBeNull();
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

  it('shows your grade over the crowd’s, each marked, when they disagree', () => {
    // State C — the Woods case in both issues: set at V0, you called it V10.
    resolveGrade.mockReturnValue({ label: 'V0', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(secondaryNode(container)?.textContent).toBe('V0');
    expect(iconNames(container)).toEqual(expect.arrayContaining(['person', 'people']));
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
    expect(secondaryNode(container)).toBeNull();
    expect(iconNames(container)).not.toContain('person');
  });

  it('marks your grade with no second line when there is no crowd number', () => {
    // State D — a draft, or an angle with no stats row.
    resolveGrade.mockReturnValue({ label: '', color: '#111111', isBoardsesh: false });
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };
    const { container } = renderRow();

    expect(gradeNode(container)?.textContent).toBe('V10');
    expect(secondaryNode(container)).toBeNull();
    expect(iconNames(container)).toContain('person');
  });
});

// A climb that lost a hold before its wall was locked lists like any other. A
// published one never reaches a wall list (search hides it); a draft does, and
// its row carries no lost-holds badge.
describe('ClimbListItemContent with lost holds', () => {
  beforeEach(() => {
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });

  it('shows no lost-holds badge and keeps the attributes beside the name', () => {
    const { container, getByText } = render(
      <ClimbListItemContent
        climb={
          { ...baseClimb, name: 'Old blue', missingHoldCount: 2, characteristics: ['no_match'] } as typeof baseClimb
        }
        boardName="spray"
        layoutId={1}
        sizeId={1}
        setIds=""
        angle={40}
      />,
    );
    expect(container.querySelector('[data-icon="frame.remove"]')).toBeNull();
    const name = getByText('Old blue');
    expect(name.parentElement?.contains(container.querySelector('[data-icon="no.match"]'))).toBe(true);
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
