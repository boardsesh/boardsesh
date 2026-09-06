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

// Icons render as a marker span so tests can assert WHICH glyph appeared (the
// favourite heart) without pulling in the real SF-Symbol / vector-icon stack.
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

describe('ClimbListItemContent grade', () => {
  beforeEach(() => {
    resolveGrade.mockReset();
    liveStatsOverride.current = null;
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

describe('ClimbListItemContent trailing rail', () => {
  beforeEach(() => {
    favoritesStore.reset();
    resolveGrade.mockReturnValue({ label: 'V4', color: '#111111', isBoardsesh: false });
  });

  const render_ = (props: Record<string, unknown> = {}) =>
    render(
      <ClimbListItemContent
        climb={baseClimb}
        boardName="kilter"
        layoutId={1}
        sizeId={1}
        setIds="1"
        angle={40}
        {...props}
      />,
    );

  it('renders a trailing accessory inside the rail, not as a column of its own', () => {
    const { container } = render_({ trailingAccessory: createElement('i', { 'data-testid': 'more' }) });
    expect(container.querySelector('[data-testid="more"]')).not.toBeNull();
  });

  it('renders nothing extra when no accessory is supplied', () => {
    const { container } = render_();
    expect(container.querySelector('[data-testid="more"]')).toBeNull();
  });

  // "V10 / 7C+" needs ~88pt at title3 — more than the rail holds once the status
  // glyphs are in it — so it used to overflow the row and paint over the name.
  it('stacks a two-scale grade onto two lines', () => {
    resolveGrade.mockReturnValue({ label: 'V10 / 7C+', color: '#abcdef', isBoardsesh: false });
    const { container } = render_();

    const primary = container.querySelector('[data-variant="title3"]');
    const secondary = container.querySelector('[data-variant="caption2"]');
    expect(primary?.textContent).toBe('V10');
    expect(secondary?.textContent).toBe('7C+');
  });

  it('leaves a single-scale grade on one line', () => {
    resolveGrade.mockReturnValue({ label: 'V10', color: '#abcdef', isBoardsesh: false });
    const { container } = render_();

    expect(container.querySelector('[data-variant="title3"]')?.textContent).toBe('V10');
    expect(container.querySelector('[data-variant="caption2"]')).toBeNull();
  });
});
