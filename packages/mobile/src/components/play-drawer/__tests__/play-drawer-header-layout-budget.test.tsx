// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom. `View` keeps its style and `Text`
// keeps its variant, so the assertions below can read the real layout values
// rather than restating them.
vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-view': 'true', 'data-style': JSON.stringify(style ?? null) }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../lib/format-climb-stats', () => ({
  formatSends: (count: number) => `${count} sends`,
  formatQuality: (value: string) => value,
}));
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant ?? 'body' }, children),
}));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant ?? 'body' }, children),
}));
// Render the centre column only — the flanks are DrawerHeader's own concern and
// have their own test.
vi.mock('../../DrawerHeader', () => ({
  DrawerHeader: ({ center }: { center?: ReactNode }) => createElement('div', null, center),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => createElement('i', null) }));
// The live tags have their own test; here they'd only drag React Query, the
// playlists provider and expo-secure-store into a presentational header test.
// This file passes its own `playlistChips` node instead.
vi.mock('../PlayDrawerPlaylistChips', () => ({ PlayDrawerPlaylistChips: () => null }));

import { PlayDrawerHeader, STATS_ROW_MARGIN_TOP } from '../PlayDrawerHeader';
import { WALL_STATE_PILL_TOUCH_HEIGHT } from '../../../theme/layout';
import { textStyles, materialTextStyles, type TextVariant } from '../../../theme/typography';

const baseProps = {
  name: 'Hueco Madness',
  difficulty: 'V5',
  qualityAverage: '3.2',
  ascensionistCount: 42,
  setterUsername: 'alexr',
};

/** The stats row: the only view carrying the header's `STATS_ROW_MARGIN_TOP`. */
function statsRow(container: HTMLElement): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLElement>('[data-view]')).find((node) =>
      (node.getAttribute('data-style') ?? '').includes(`"marginTop":${STATS_ROW_MARGIN_TOP}`),
    ) ?? null
  );
}

function variantOf(node: Element | null | undefined): TextVariant {
  return (node?.getAttribute('data-variant') ?? 'body') as TextVariant;
}

/**
 * The centre column as the component actually builds it: the climb-name label's
 * type variant and the stats label's type variant, read back off a real render —
 * so swapping either label to a bigger variant moves the budget below instead of
 * quietly passing. Rendered per test: RTL's auto-cleanup empties the container
 * between them.
 */
function measureCentreColumn() {
  const { container } = render(<PlayDrawerHeader {...baseProps} />);
  return {
    container,
    nameVariant: variantOf(container.querySelector('button span')),
    statsVariant: variantOf(statsRow(container)?.querySelector('span')),
  };
}

describe('PlayDrawerHeader layout budget', () => {
  it.each([
    ['Liquid Glass (HIG scale, iOS)', textStyles],
    ['Material (M3 scale, Android)', materialTextStyles],
  ])('fits the whole centre column under the row floor on %s', (_label, scale) => {
    // The play drawer's first screen is a FIXED height with the board art `flex: 1`
    // inside it, so a taller header renders the board SMALLER — which is exactly
    // what a chips line of its own did (QA declined PR #4560 for it). Name + stats
    // is what every climb pays; keeping it under `minRowHeight` is what makes the
    // playlist tags free. (The climb-RULES line is a deliberate exception and is
    // not rendered here — these props carry no rules.)
    //
    // Both scales, not just the HIG one: Material is the resolved variant on every
    // Android device, and its `body` line box is 2pt taller.
    const { nameVariant, statsVariant } = measureCentreColumn();
    const centreColumn = scale[nameVariant].lineHeight + STATS_ROW_MARGIN_TOP + scale[statsVariant].lineHeight;

    expect(centreColumn).toBeLessThanOrEqual(WALL_STATE_PILL_TOUCH_HEIGHT);
  });

  it('gives the stats row no fixed height, so it is one caption line either way', () => {
    // A pinned height is what broke Android the first time round: 20pt cleared the
    // 44pt floor on the HIG scale and missed it on M3. The row is left to size to
    // its content instead — and its content is `caption1` on both sides, tags or no
    // tags, so it measures the same regardless.
    const row = statsRow(measureCentreColumn().container);
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-style') ?? '').not.toContain('"height"');
  });

  it('puts the playlist tag inside the stats row, ahead of the stats', () => {
    const withChips = render(<PlayDrawerHeader {...baseProps} playlistChips={<span>Sunday sends</span>} />);
    const row = statsRow(withChips.container);
    expect(row).not.toBeNull();
    // Inside the row, not a sibling under it — a sibling is a third line, and a
    // third line is board art.
    const text = row?.textContent ?? '';
    expect(text).toContain('Sunday sends');
    expect(text).toContain('alexr');
    // Tag first: the stats carry `numberOfLines={1}` and ellipsize from the tail,
    // so trailing them means the setter is what a squeeze eats, not the tag.
    expect(text.indexOf('Sunday sends')).toBeLessThan(text.indexOf('alexr'));
  });
});
