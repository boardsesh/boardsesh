// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
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
    | { status: 'set'; difficultyId: number; climbedAt: string },
}));

vi.mock('@boardsesh/board-react', () => ({
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
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ boardseshActive: true, resolveGrade }),
}));

vi.mock('../../hooks/use-ascent-status', () => ({
  useAscentStatus: () => null,
}));

vi.mock('../../hooks/use-my-grade', () => ({
  useMyGrade: () => myGradeOverride.current,
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

vi.mock('../ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => null,
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
vi.mock('../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
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
