// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The system text size the bar reads (Android's 200% is 2).
const windowFont = vi.hoisted(() => ({ scale: 1 }));
// react-native isn't satisfiable under jsdom; stub the surface the label touches.
// See play-drawer-header-stats-angle.test.tsx for the same pattern.
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: windowFont.scale }),
  View: ({
    children,
    accessible,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement(
      'div',
      { 'data-accessible': accessible ? 'true' : undefined, 'aria-label': accessibilityLabel, 'data-testid': testID },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
const theme = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' }, colorScheme: theme.colorScheme }),
}));
vi.mock('../../../theme/colors', () => ({
  materialSurfaces: { light: { secondaryLabel: '#5A5A5A' }, dark: { secondaryLabel: '#B0B0B0' } },
}));
// The iOS viewer's title, recorded so the test can read what it would show.
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ title, children }: { title: string; children?: ReactNode }) =>
    createElement('section', { 'data-large-content-title': title }, children),
}));
// Android's answer: font scaling off, the line height scaled by hand (see
// use-capped-text-props). The label must hand it to every one of its texts.
vi.mock('../../../hooks/use-capped-text-props', () => ({
  useCappedTextProps: () => ({ allowFontScaling: false, style: { lineHeight: 19.2 } }),
}));
type MockTextStyle = { flexShrink?: number; textAlign?: string; lineHeight?: number };
type TextLayout = { nativeEvent: { lines: { width: number }[] } };
// The measuring texts' layout callbacks, by testID, so a test can say how the
// words laid out in the frame.
const roomProbes = vi.hoisted(() => new Map<string, (event: TextLayout) => void>());
vi.mock('../../Text', () => ({
  Text: ({
    children,
    numberOfLines,
    numeric,
    allowFontScaling,
    color,
    style,
    variant,
    testID,
    onTextLayout,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    numeric?: boolean;
    allowFontScaling?: boolean;
    color?: string;
    style?: MockTextStyle | MockTextStyle[];
    variant?: string;
    testID?: string;
    onTextLayout?: (event: TextLayout) => void;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) => {
    const flat: MockTextStyle = Object.assign({}, ...[style].flat().filter(Boolean));
    if (testID && onTextLayout) roomProbes.set(testID, onTextLayout);
    return createElement(
      'span',
      {
        'data-probe': onTextLayout ? 'true' : undefined,
        'data-a11y-hidden':
          accessibilityElementsHidden && importantForAccessibility === 'no-hide-descendants' ? 'true' : undefined,
        'data-testid': testID,
        'data-variant': variant,
        'data-color': color,
        'data-lines': numberOfLines,
        'data-numeric': numeric ? 'true' : undefined,
        'data-shrink': flat.flexShrink === undefined ? undefined : flat.flexShrink,
        'data-align': flat.textAlign,
        'data-font-scaling': String(allowFontScaling),
        'data-line-height': flat.lineHeight,
      },
      children,
    );
  },
}));

import { PlayListContext, resolveThenPlacement, thenRoomLines } from '../PlayListContext';
import type { TrackLabelParts } from '../track-label-text';

beforeEach(() => {
  theme.colorScheme = 'light';
  windowFont.scale = 1;
  roomProbes.clear();
});

/** "Up next · 4 of 4 · then Projects": the last Up next climb before the list goes on. */
const thenParts: TrackLabelParts = {
  name: 'Up next',
  count: '4 of 4',
  thenTail: { before: 'then ', name: 'Projects', after: '' },
  accessibilityLabel: 'Up next, 4 of 4, then Projects',
};

/** The texts a climber sees: the room probes are laid out but never shown. */
const texts = (container: HTMLElement) => Array.from(container.querySelectorAll('span:not([data-probe])'));

/**
 * How the measuring texts laid out in the frame the bar has now: one line
 * means the words fit. Widths are rough caption1 measures at 1.0x: the frame
 * is about 255pt beside ⌄ and ⋯, about 185pt with the rest timer up.
 */
function measureRoom({ withName, bare }: { withName: number[]; bare: number[] }) {
  act(() => {
    roomProbes.get('play-drawer-then-room-name')?.({ nativeEvent: { lines: withName.map((width) => ({ width })) } });
    roomProbes.get('play-drawer-then-room-bare')?.({ nativeEvent: { lines: bare.map((width) => ({ width })) } });
  });
}

describe('PlayListContext', () => {
  it('prints the name and the count as two texts, and only the name may shrink', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Search results', count: '1 of 29,182', accessibilityLabel: 'Playing from Search results' },
      }),
    );
    const [name, count] = texts(container);
    expect(name?.textContent).toBe('Search results');
    expect(name?.getAttribute('data-shrink')).toBe('1');
    expect(name?.getAttribute('data-lines')).toBe('1');
    expect(count?.textContent).toBe(' · 1 of 29,182');
    expect(count?.getAttribute('data-shrink')).toBe('0');
    expect(count?.getAttribute('data-numeric')).toBe('true');
  });

  // A cut name's "…" stops short of its box; right-aligned, the spare room
  // falls on the outer edge instead of between the name and the count.
  it('right-aligns the name so a cut one sits against the count', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
      }),
    );
    expect(texts(container)[0]?.getAttribute('data-align')).toBe('right');
  });

  it('prints the name alone when the count is not known', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: null, accessibilityLabel: 'Playing from Projects' },
      }),
    );
    expect(texts(container).map((text) => text.textContent)).toEqual(['Projects']);
  });

  // One element for VoiceOver, with the whole name even when the layout cuts it.
  it('reads as one element with the full label', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: {
          name: 'Winter crimp ladder, 40° only, no dynos please',
          count: '4 of 23',
          accessibilityLabel: 'Playing from Winter crimp ladder, 40° only, no dynos please, 4 of 23',
        },
        testID: 'play-drawer-track-label',
      }),
    );
    const group = container.querySelector('[data-testid="play-drawer-track-label"]');
    expect(group?.getAttribute('data-accessible')).toBe('true');
    expect(group?.getAttribute('aria-label')).toBe(
      'Playing from Winter crimp ladder, 40° only, no dynos please, 4 of 23',
    );
  });

  // The second line #6745 made room for: the preview caption rides it instead
  // of leading the header's stats line, where it pushed the sends and stars off.
  // A screen reader hears its "·" as a comma, never "middle dot" (B1).
  it('adds the wall caption as a second line, read with the list', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
        testID: 'play-drawer-track-label',
      }),
    );
    expect(texts(container).map((text) => text.textContent)).toEqual([
      'Projects',
      ' · 4 of 23',
      'Preview · not on the wall',
    ]);
    expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toBe(
      'Playing from Projects, 4 of 23. Preview, not on the wall',
    );
  });

  it('shows the caption alone when there is no list', () => {
    const { container } = render(createElement(PlayListContext, { parts: null, caption: 'Preview · not on the wall' }));
    expect(texts(container).map((text) => text.textContent)).toEqual(['Preview · not on the wall']);
  });

  // iOS's translucent secondaryLabel is 3.44:1 on a white sheet; Velvet's
  // opaque one clears AA on every ground (wall-control-button-contrast.test.ts).
  it.each([
    ['light', '#5A5A5A'],
    ['dark', '#B0B0B0'],
  ] as const)('draws the caption in Velvet secondary label in %s', (scheme, color) => {
    theme.colorScheme = scheme;
    const { container } = render(createElement(PlayListContext, { parts: null, caption: 'Preview · not on the wall' }));
    expect(texts(container)[0]?.getAttribute('data-color')).toBe(color);
  });

  // The bar is capped at 1.2x, so the Large Content Viewer is how the words
  // reach someone who needs them larger.
  it('hands the Large Content Viewer both lines as printed', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
      }),
    );
    expect(container.querySelector('section')?.getAttribute('data-large-content-title')).toBe(
      'Projects · 4 of 23. Preview · not on the wall',
    );
  });

  it('renders nothing with neither', () => {
    const { container } = render(createElement(PlayListContext, { parts: null }));
    expect(container.innerHTML).toBe('');
  });

  // At Android's 2.0 text size the line heights grew past the cap and the
  // first line ran into the grabber (#6702 QA).
  it('hands every text the capped scaling, line height included', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
      }),
    );
    const all = texts(container);
    expect(all).toHaveLength(3);
    for (const text of all) {
      expect(text.getAttribute('data-font-scaling')).toBe('false');
      expect(text.getAttribute('data-line-height')).toBe('19.2');
    }
  });

  // The then-signposts: the tail's list name is cut first; "Up next", the
  // count and "then" are never cut.
  it('prints "· then Projects" after the count, and only the list name may shrink', () => {
    const { container } = render(
      createElement(PlayListContext, { parts: thenParts, testID: 'play-drawer-track-label' }),
    );
    const all = texts(container);
    expect(all.map((text) => text.textContent)).toEqual(['Up next', ' · 4 of 4', ' · then ', 'Projects']);
    expect(all.map((text) => text.getAttribute('data-shrink'))).toEqual(['0', '0', '0', '1']);
    // One line: the four texts share a row.
    expect(new Set(all.map((text) => text.parentElement)).size).toBe(1);
    expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toBe(
      'Up next, 4 of 4, then Projects',
    );
    expect(container.querySelector('section')?.getAttribute('data-large-content-title')).toBe(
      'Up next · 4 of 4 · then Projects',
    );
  });

  it('keeps the words after a name the language puts first whole too', () => {
    const suffix: TrackLabelParts = { ...thenParts, thenTail: { before: '', name: 'Projekte', after: ' danach' } };
    const all = texts(render(createElement(PlayListContext, { parts: suffix })).container);
    expect(all.map((text) => text.textContent)).toEqual(['Up next', ' · 4 of 4', ' · ', 'Projekte', ' danach']);
    expect(all.map((text) => text.getAttribute('data-shrink'))).toEqual(['0', '0', '0', '1', '0']);
  });

  it('measures the first line with the never-cut words and the shortest name', () => {
    expect(thenRoomLines(thenParts, thenParts.thenTail!)).toEqual({
      withName: 'Up next · 4 of 4 · then Projec\u2026',
      bare: 'Up next · 4 of 4 · then \u2026',
    });
    // German at the last Up next climb: "danach" before the name, nothing after.
    const german: TrackLabelParts = {
      name: 'Als Nächstes',
      count: '4 von 4',
      thenTail: { before: 'danach ', name: 'Suchergebnisse', after: '' },
      accessibilityLabel: 'Als Nächstes, 4 von 4, danach Suchergebnisse',
    };
    expect(thenRoomLines(german, german.thenTail!).withName).toBe('Als Nächstes · 4 von 4 · danach Sucher\u2026');
    // A short name is measured whole.
    const short = { ...thenParts, thenTail: { before: 'then ', name: 'Mine', after: '' } };
    expect(thenRoomLines(short, short.thenTail).withName).toBe('Up next · 4 of 4 · then Mine');
  });

  it('places "then" by the room measured and whether line 2 is free', () => {
    const room = (withName: boolean | null, bare: boolean | null) => ({ withName, bare });
    expect(resolveThenPlacement({ hasThen: false, hasCaption: false, room: room(false, false) })).toBeNull();
    // Not measured yet: the first layout measures it.
    expect(resolveThenPlacement({ hasThen: true, hasCaption: true, room: room(null, null) })).toBe('inline');
    expect(resolveThenPlacement({ hasThen: true, hasCaption: true, room: room(true, true) })).toBe('inline');
    // Fewer than six characters of the name would show: line 2, while it is free.
    expect(resolveThenPlacement({ hasThen: true, hasCaption: false, room: room(false, true) })).toBe('ownLine');
    expect(resolveThenPlacement({ hasThen: true, hasCaption: false, room: room(false, false) })).toBe('ownLine');
    // Line 2 taken: "then …" if it fits, and only spoken when even that does not.
    expect(resolveThenPlacement({ hasThen: true, hasCaption: true, room: room(false, true) })).toBe('inline');
    expect(resolveThenPlacement({ hasThen: true, hasCaption: true, room: room(false, false) })).toBe('spoken');
  });

  it('moves "then Projects" to line 2, at line 2\'s size, when the first line has no room for the name', () => {
    // English with the rest timer up: "Up next · 4 of 4 · then Projec…" wraps a 185pt frame.
    const { container } = render(
      createElement(PlayListContext, { parts: thenParts, testID: 'play-drawer-track-label' }),
    );
    measureRoom({ withName: [150, 40], bare: [160] });
    const all = texts(container);
    expect(all.map((text) => text.textContent)).toEqual(['Up next', ' · 4 of 4', 'then ', 'Projects']);
    expect(all[0]?.parentElement).not.toBe(all[2]?.parentElement);
    expect(all[2]?.parentElement).toBe(all[3]?.parentElement);
    // The same type as a caption, so the pair is as tall as the list and a caption.
    expect(all.slice(2).map((text) => text.getAttribute('data-variant'))).toEqual(['caption2', 'caption2']);
    // On its own line nothing beside it competes for room: the name stays as it was.
    expect(all[0]?.getAttribute('data-shrink')).toBe('1');
    expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toBe(
      'Up next, 4 of 4, then Projects',
    );
  });

  it('keeps a cut "then" on the first line when a caption takes the second and "then …" fits', () => {
    const { container } = render(
      createElement(PlayListContext, { parts: thenParts, caption: 'Preview · not on the wall' }),
    );
    measureRoom({ withName: [150, 40], bare: [160] });
    expect(texts(container).map((text) => text.textContent)).toEqual([
      'Up next',
      ' · 4 of 4',
      ' · then ',
      'Projects',
      'Preview · not on the wall',
    ]);
  });

  it.each([
    [
      'German',
      { name: 'Als Nächstes', count: '4 von 4', before: 'danach ', listName: 'Suchergebnisse' },
      'Vorschau · nicht am Board',
    ],
    [
      'Spanish',
      { name: 'A continuación', count: '4 de 4', before: 'luego ', listName: 'Resultados de búsqueda' },
      'Vista previa · no está en el plafón',
    ],
  ])(
    'in %s with the timer up and line 2 taken, never runs under ⌄ or the timer: "then" is only spoken',
    (_, words, caption) => {
      const parts: TrackLabelParts = {
        name: words.name,
        count: words.count,
        thenTail: { before: words.before, name: words.listName, after: '' },
        accessibilityLabel: `${words.name}, ${words.count}, ${words.before}${words.listName}`,
      };
      const { container } = render(
        createElement(PlayListContext, { parts, caption, testID: 'play-drawer-track-label' }),
      );
      // About 210pt of never-cut words in a 185pt frame: even "then …" wraps.
      measureRoom({ withName: [180, 70], bare: [180, 30] });
      const all = texts(container);
      expect(all.map((text) => text.textContent)).toEqual([words.name, ` · ${words.count}`, caption]);
      // The list's name shrinks again, as on any first line.
      expect(all[0]?.getAttribute('data-shrink')).toBe('1');
      // A screen reader and the Large Content Viewer still get the whole line.
      expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toContain(
        `${words.before}${words.listName}`,
      );
      expect(container.querySelector('section')?.getAttribute('data-large-content-title')).toContain(
        `${words.before}${words.listName}`,
      );
    },
  );

  it('comes back to the first line once the frame has room again (the timer went away)', () => {
    const { container } = render(
      createElement(PlayListContext, { parts: thenParts, caption: 'Preview · not on the wall' }),
    );
    measureRoom({ withName: [180, 70], bare: [180, 30] });
    expect(texts(container).map((text) => text.textContent)).not.toContain(' · then ');
    measureRoom({ withName: [230], bare: [200] });
    expect(texts(container).map((text) => text.textContent)).toContain(' · then ');
  });

  it('measures nothing on a line with no "then"', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '7 of 20', accessibilityLabel: 'Playing from Projects, 7 of 20' },
      }),
    );
    expect(container.querySelector('[data-probe]')).toBeNull();
  });

  it('hides the measuring texts from VoiceOver and TalkBack', () => {
    const { container } = render(createElement(PlayListContext, { parts: thenParts }));
    const probes = Array.from(container.querySelectorAll('[data-probe]'));
    expect(probes).toHaveLength(2);
    expect(probes.map((probe) => probe.getAttribute('data-a11y-hidden'))).toEqual(['true', 'true']);
  });

  it('carries the second-line signposts like any caption', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '7 of 20', accessibilityLabel: 'Playing from Projects, 7 of 20' },
        caption: 'Up next first · 4 climbs',
        testID: 'play-drawer-track-label',
      }),
    );
    expect(texts(container).map((text) => text.textContent)).toEqual([
      'Projects',
      ' · 7 of 20',
      'Up next first · 4 climbs',
    ]);
    expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toBe(
      'Playing from Projects, 7 of 20. Up next first, 4 climbs',
    );
  });
});
