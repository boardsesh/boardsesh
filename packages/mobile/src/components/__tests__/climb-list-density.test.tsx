// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';

// Geometry-only test: what each density tier renders, and what it hands the
// thumbnail. Everything the row reaches for at runtime (live stats, grade
// resolution, logbook, theme) is stubbed — the assertions are about SIZE and
// which lines exist, nothing else.

vi.mock('@boardsesh/board-react', () => ({
  useEffectiveClimbStats: (
    _boardName: string,
    _layoutId: number,
    _climbUuid: string,
    _angle: number,
    base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
  ) => ({
    ascensionistCount: base.ascensionistCount ?? 0,
    qualityAverage: base.qualityAverage ?? null,
    difficulty: base.difficulty ?? null,
  }),
}));

// View keeps its style on the DOM node so the thumbnail cell's width/height are
// assertable — the whole point of the compact tier.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  // theme/tokens (via the frames pip) reaches theme/colors, which branches on
  // `Platform.OS` and only calls `PlatformColor` on iOS.
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.android ?? choices.default },
  PlatformColor: (name: string) => name,
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
    return createElement('div', { 'data-style': JSON.stringify(flattened) }, children);
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({
    boardseshActive: false,
    resolveGrade: () => ({ label: 'V4', color: '#111111', isBoardsesh: false }),
  }),
}));

vi.mock('../../hooks/use-ascent-status', () => ({ useAscentStatus: () => null }));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' }, actionColors: { favorite: '#FF3B30' } }),
}));

vi.mock('../../lib/format-climb-stats', () => ({
  formatSends: () => '10 sends',
  formatQuality: () => '4.5',
}));

vi.mock('../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));

// Records the size handed to the thumbnail. `undefined` is meaningful: it means the
// row asked for the untouched default cell.
vi.mock('../ClimbListThumbnail', () => ({
  ClimbListThumbnail: ({ size }: { size?: { width: number; height: number } }) =>
    createElement('img', { 'data-size': size ? `${size.width}x${size.height}` : 'default' }),
  THUMBNAIL_WIDTH: 76,
  THUMBNAIL_HEIGHT: 96,
}));

vi.mock('../Icon', () => ({
  Icon: ({ name, size }: { name: string; size?: number }) =>
    createElement('i', { 'data-icon': name, 'data-size': String(size) }),
}));
vi.mock('../ClimbAttributeIcons', () => ({
  ClimbAttributeIcons: () => createElement('i', { 'data-icon': 'attributes' }),
}));
vi.mock('../ClimbPlaylistChips', () => ({
  ClimbPlaylistChips: ({ forceVisible }: { forceVisible?: boolean }) =>
    createElement('div', { 'data-chips': forceVisible ? 'forced' : 'gated' }),
}));

import { ClimbListItemContent } from '../ClimbListItemContent';
import {
  COMPACT_THUMBNAIL_HEIGHT,
  COMPACT_THUMBNAIL_WIDTH,
  THUMBNAIL_WIDTH,
  separatorInsetForDensity,
  thumbnailSizeForDensity,
} from '../climb-list-thumbnail-metrics';

const climb = {
  uuid: 'c1',
  name: 'Golden Boy',
  frames: 'p1r1',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 10,
  setter_username: 'setter',
};

function renderRow(props: Partial<ComponentProps<typeof ClimbListItemContent>> = {}) {
  return render(
    <ClimbListItemContent climb={climb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} {...props} />,
  );
}

const thumbnailSizeAttr = (container: HTMLElement) => container.querySelector('img')?.getAttribute('data-size');
const subtitle = (container: HTMLElement) => container.querySelector('[data-variant="footnote"]');
const chips = (container: HTMLElement) => container.querySelector('[data-chips]');
const thumbnailCellStyle = (container: HTMLElement) =>
  JSON.parse(container.querySelector('div[data-style]')?.getAttribute('data-style') ?? '{}') as {
    width?: number;
    height?: number;
  };

describe('climb list density — default tier', () => {
  it('renders today shape: 76x96 cell, the sends/quality/setter subtitle, and no size override', () => {
    const { container } = renderRow();
    expect(thumbnailCellStyle(container)).toMatchObject({ width: 76, height: 96 });
    expect(thumbnailSizeAttr(container)).toBe('default');
    expect(subtitle(container)).not.toBeNull();
  });

  it('is what a row with no density prop at all renders — the two are the same tree', () => {
    const withoutProp = renderRow().container.innerHTML;
    const withDefault = renderRow({ density: 'default' }).container.innerHTML;
    expect(withDefault).toBe(withoutProp);
  });

  it('keeps the playlist tags gated on the user setting', () => {
    const { container } = renderRow({ density: 'default', showPlaylistChips: true });
    expect(chips(container)?.getAttribute('data-chips')).toBe('gated');
  });
});

describe('climb list density — compact tier', () => {
  it('shrinks the thumbnail cell to 56x72, which is what actually shortens the row', () => {
    const { container } = renderRow({ density: 'compact' });
    expect(thumbnailCellStyle(container)).toMatchObject({
      width: COMPACT_THUMBNAIL_WIDTH,
      height: COMPACT_THUMBNAIL_HEIGHT,
    });
    expect(thumbnailSizeAttr(container)).toBe('56x72');
  });

  it('drops the subtitle but keeps the name, the attribute glyphs and the grade', () => {
    const { container } = renderRow({ density: 'compact' });
    expect(subtitle(container)).toBeNull();
    expect(container.textContent).toContain('Golden Boy');
    expect(container.querySelector('[data-icon="attributes"]')).not.toBeNull();
    expect(container.querySelector('[data-variant="title3"]')?.textContent).toBe('V4');
  });

  it('shows no playlist tags even when the surface opts in', () => {
    const { container } = renderRow({ density: 'compact', showPlaylistChips: true });
    expect(chips(container)).toBeNull();
  });
});

describe('climb list density — rich tier', () => {
  it('keeps the default 76x96 cell — a richer tier adds lines, never pixels', () => {
    const { container } = renderRow({ density: 'rich' });
    expect(thumbnailCellStyle(container)).toMatchObject({ width: 76, height: 96 });
    expect(thumbnailSizeAttr(container)).toBe('default');
  });

  it('promotes the playlist tags under the subtitle, whatever the tags setting says', () => {
    const { container } = renderRow({ density: 'rich' });
    expect(subtitle(container)).not.toBeNull();
    expect(chips(container)?.getAttribute('data-chips')).toBe('forced');
  });
});

describe('climb list density — frames pip', () => {
  const pip = (container: HTMLElement) => container.querySelector('[data-icon="frames"]');
  const route = { ...climb, framesCount: 3 };

  it('marks a multi-frame route on every tier, so a mixed boulders + routes filter stays readable', () => {
    for (const density of ['compact', 'default', 'rich'] as const) {
      const { container } = renderRow({ climb: route, density });
      expect(pip(container)).not.toBeNull();
      expect(container.textContent).toContain('3');
    }
  });

  it('shrinks its glyph on the compact tier, whose cell is 56x72 rather than 76x96', () => {
    const compactGlyph = Number(
      pip(renderRow({ climb: route, density: 'compact' }).container)?.getAttribute('data-size'),
    );
    const defaultGlyph = Number(
      pip(renderRow({ climb: route, density: 'default' }).container)?.getAttribute('data-size'),
    );
    expect(compactGlyph).toBeLessThan(defaultGlyph);
  });

  it('shows nothing for a single-frame boulder, or a climb whose count never arrived', () => {
    expect(pip(renderRow({ climb: { ...climb, framesCount: 1 } }).container)).toBeNull();
    expect(pip(renderRow({ climb: { ...climb, framesCount: null } }).container)).toBeNull();
    expect(pip(renderRow().container)).toBeNull();
  });

  it('leaves the thumbnail cell exactly as it was — a pip is a View, not another image layer', () => {
    expect(thumbnailCellStyle(renderRow({ climb: route }).container)).toMatchObject({ width: 76, height: 96 });
    expect(thumbnailSizeAttr(renderRow({ climb: route }).container)).toBe('default');
  });
});

describe('climb list density metrics', () => {
  it('never hands the thumbnail a cell wider than the default 76pt', () => {
    for (const density of ['compact', 'default', 'rich'] as const) {
      expect(thumbnailSizeForDensity(density).width).toBeLessThanOrEqual(THUMBNAIL_WIDTH);
    }
  });

  it('derives every separator inset from the tier own thumbnail width, not a second magic number', () => {
    expect(separatorInsetForDensity('default')).toBe(76 + 8 + 12);
    expect(separatorInsetForDensity('rich')).toBe(76 + 8 + 12);
    expect(separatorInsetForDensity('compact')).toBe(COMPACT_THUMBNAIL_WIDTH + 8 + 12);
  });
});
