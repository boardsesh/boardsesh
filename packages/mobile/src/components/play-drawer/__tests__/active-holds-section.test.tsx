// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { HOLD_STATE_MAP, getHoldDisplayColor } from '@boardsesh/board-constants/hold-states';
import { contrastRatio } from '@boardsesh/board-constants/readable-text-color';
import { coordinateToHoldId, type MoonBoardCoordinate } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldColorOverrides, HoldShapeOverrides } from '../../../lib/hold-color-overrides';

const harness = vi.hoisted(() => ({
  look: { mode: 'aura' as 'aura' | 'classic', roleGlyphs: false },
  colors: {} as HoldColorOverrides,
  shapes: {} as HoldShapeOverrides,
  // The stored marker signature, as the board's renderer is asked for it.
  renderSignature: 'stored-markers',
  // Each View's onLayout by testID, so a case can play the layout pass.
  layouts: new Map<string, (event: { nativeEvent: { layout: { width: number } } }) => void>(),
  spokenSummary: undefined as string | undefined,
  hidesTitle: undefined as boolean | undefined,
}));

// The English copy, so labels read as a climber hears them.
const COPY: Record<string, string> = {
  'mobile.activeHolds.title': 'Active holds',
  'mobile.activeHolds.a11yGroup': '{{role}}: {{holds}}',
  'mobile.activeHolds.empty': 'This climb lights no holds.',
  'mobile.create.brush.start': 'Start',
  'mobile.create.brush.hand': 'Hand',
  'mobile.create.brush.finish': 'Finish',
  'mobile.create.brush.foot': 'Foot',
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      (COPY[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  }),
}));
vi.mock('react-native', () => ({
  View: ({
    children,
    style,
    testID,
    accessibilityLabel,
    onLayout,
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) => {
    if (testID && onLayout) harness.layouts.set(testID, onLayout);
    return createElement(
      'div',
      { 'data-testid': testID, 'data-style': JSON.stringify(style), 'aria-label': accessibilityLabel },
      children,
    );
  },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color, testID }: { children?: ReactNode; color?: string; testID?: string }) =>
    createElement('span', { 'data-color': color, 'data-testid': testID }, children),
}));
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    summaryAccessibilityLabel,
    hideTitleWhenCollapsed,
    children,
  }: {
    title: string;
    summary?: ReactNode;
    summaryAccessibilityLabel?: string;
    hideTitleWhenCollapsed?: boolean;
    children?: ReactNode;
  }) => {
    harness.spokenSummary = summaryAccessibilityLabel;
    harness.hidesTitle = hideTitleWhenCollapsed;
    return createElement('section', { 'data-title': title }, createElement('header', null, summary), children);
  },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: 'label', secondaryLabel: 'secondaryLabel' },
    textStyles: { footnote: { fontSize: 13, fontWeight: '400', lineHeight: 18 } },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { sm: 4 } }));
vi.mock('../../../hooks/use-board-render-look', () => ({ useBoardRenderMode: () => harness.look }));
// Real colour and shape rules; only the climber's stored choices are faked.
vi.mock('../../../lib/hold-color-overrides', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hold-color-overrides')>()),
  useHoldColorOverrides: () => ({
    overrides: harness.colors,
    shapes: harness.shapes,
    brushThickness: 1,
    shapeSize: 1,
    renderSignature: harness.renderSignature,
  }),
}));

const { ActiveHoldsSection, markerChipColor, markerGlyph } = await import('../ActiveHoldsSection');
const { PlaybackFrameContext } = await import('../playback-frame-context');
const { _resetActiveHoldsLineMemoryForTests } = await import('../active-holds-line');
const { _unsupportedRenderSignaturesForTests, markRenderSignatureUnsupported } =
  await import('../../../hooks/marker-renderer-support');

function moonHold(coordinate: MoonBoardCoordinate, roleCode: number): string {
  return `p${coordinateToHoldId(coordinate)}r${roleCode}`;
}
// The MoonBoard climb from the issue's sample, stored in the setter's order.
const MOON_FRAMES = [
  moonHold('B5', 42),
  moonHold('H13', 43),
  moonHold('I14', 43),
  moonHold('F10', 43),
  moonHold('K8', 43),
  moonHold('F8', 43),
  moonHold('J18', 44),
].join('');
// Every role, foot included (code 45, our firmware's live-preview foot).
const MOON_ALL_ROLES = [moonHold('A1', 42), moonHold('C3', 43), moonHold('E5', 44), moonHold('G7', 45)].join('');

function renderSection(boardName: BoardName, frames: string) {
  return render(createElement(ActiveHoldsSection, { boardName, layoutId: 1, frames }));
}
function rowText(view: ReturnType<typeof renderSection>, role: string): string | null | undefined {
  return view.getByTestId(`active-holds-row-${role}`).textContent;
}
function markerOf(view: ReturnType<typeof renderSection>, role: string): Element {
  const marker = view.getByTestId(`active-holds-row-${role}`).querySelector('[data-color]');
  if (!marker) throw new Error(`no marker for ${role}`);
  return marker;
}

/** Plays the layout pass: the room the header leaves, and each reading's natural width. */
function layOut(available: number, widths: Record<string, number>) {
  act(() => {
    harness.layouts.get('active-holds-line-frame')?.({ nativeEvent: { layout: { width: available } } });
    for (const [key, width] of Object.entries(widths)) {
      harness.layouts.get(`active-holds-measure-${key}`)?.({ nativeEvent: { layout: { width } } });
    }
  });
}
function lineText(view: ReturnType<typeof renderSection>): string | null {
  return view.queryByTestId('active-holds-line')?.textContent ?? null;
}

beforeEach(() => {
  harness.look = { mode: 'aura', roleGlyphs: false };
  harness.colors = {};
  harness.shapes = {};
  harness.renderSignature = 'stored-markers';
  _unsupportedRenderSignaturesForTests.clear();
  harness.layouts.clear();
  harness.spokenSummary = undefined;
  _resetActiveHoldsLineMemoryForTests();
});
afterEach(cleanup);

describe('ActiveHoldsSection', () => {
  it('lists MoonBoard coordinates bottom to top, a row a role', () => {
    const view = renderSection('moonboard', MOON_FRAMES);
    expect(view.container.querySelector('section')?.getAttribute('data-title')).toBe('Active holds');
    expect(rowText(view, 'STARTING')).toBe('●StartB5');
    expect(rowText(view, 'HAND')).toBe('●HandF8 K8 F10 H13 I14');
    expect(rowText(view, 'FINISH')).toBe('●FinishJ18');
  });

  it('draws the collapsed line as each marker followed by every coordinate when they fit', () => {
    const moon = renderSection('moonboard', MOON_FRAMES);
    layOut(260, { labels: 240, handFirst: 120, handCount: 100 });
    expect(lineText(moon)).toBe('●B5●F8 K8 F10 H13 I14●J18');
    const groups = [...moon.getByTestId('active-holds-line').children];
    expect(groups.every((group) => !group.getAttribute('data-style')?.includes('"flexShrink":1'))).toBe(true);
  });

  it('cuts only Hand short, keeping its chip, when the coordinates do not all fit', () => {
    const view = renderSection('moonboard', MOON_FRAMES);
    layOut(180, { labels: 240, handFirst: 120, handCount: 100 });
    const groups = [...view.getByTestId('active-holds-line').children];
    const shrinking = groups.filter((group) => group.getAttribute('data-style')?.includes('"flexShrink":1'));
    expect(shrinking.map((group) => group.textContent)).toEqual(['●F8 K8 F10 H13 I14']);
    // Chip (18) plus its gap (4): Hand never shrinks to nothing under Finish.
    expect(shrinking[0]?.getAttribute('data-style')).toContain('"minWidth":22');
    expect(shrinking[0]?.getAttribute('data-style')).toContain('"overflow":"hidden"');
  });

  it('counts Hand when not even its first coordinate fits, and names the section when nothing does', () => {
    const view = renderSection('moonboard', MOON_FRAMES);
    layOut(110, { labels: 240, handFirst: 120, handCount: 100 });
    expect(lineText(view)).toBe('●B5●5●J18');
    layOut(90, {});
    expect(lineText(view)).toBeNull();
    expect(view.getByTestId('active-holds-line-title').textContent).toBe('Active holds');
  });

  it('keeps the last reading while a new climb measures, and after the section folds open and shut', () => {
    const view = renderSection('moonboard', MOON_FRAMES);
    layOut(110, { labels: 240, handFirst: 120, handCount: 100 });
    expect(lineText(view)).toBe('●B5●5●J18');
    // New coordinates (new letters) are unmeasured: the last reading stands in, not every coordinate.
    const otherFrames = [moonHold('A3', 42), moonHold('C7', 43), moonHold('D9', 43), moonHold('E18', 44)].join('');
    view.rerender(createElement(ActiveHoldsSection, { boardName: 'moonboard', layoutId: 1, frames: otherFrames }));
    expect(lineText(view)).toBe('●A3●2●E18');
    // Unmounted and back (the summary unmounts while the section is open): widths and room are remembered.
    view.unmount();
    harness.layouts.clear();
    const again = renderSection('moonboard', MOON_FRAMES);
    expect(lineText(again)).toBe('●B5●5●J18');
  });

  it("reads every hold on the collapsed header, which shows the line in the title's place", () => {
    renderSection('moonboard', MOON_FRAMES);
    expect(harness.hidesTitle).toBe(true);
    expect(harness.spokenSummary).toBe('Start: B5. Hand: F8, K8, F10, H13, I14. Finish: J18.');
  });

  it("reads the playback frame on screen over the climb's frames", () => {
    const view = render(
      createElement(
        PlaybackFrameContext.Provider,
        { value: moonHold('D4', 42) },
        createElement(ActiveHoldsSection, { boardName: 'moonboard', layoutId: 1, frames: MOON_FRAMES }),
      ),
    );
    expect(view.getByTestId('active-holds-row-STARTING').textContent).toBe('●StartD4');
    expect(view.queryByTestId('active-holds-row-HAND')).toBeNull();
  });

  it('reads every row out in full', () => {
    const moon = renderSection('moonboard', MOON_FRAMES);
    expect(moon.getByTestId('active-holds-row-HAND').getAttribute('aria-label')).toBe('Hand: F8, K8, F10, H13, I14');
  });

  it('says so for a climb with no holds lit', () => {
    const view = renderSection('moonboard', '');
    expect(view.container.textContent).toBe('This climb lights no holds.');
    expect(view.container.querySelector('header')?.childElementCount).toBe(0);
  });

  it('colours each marker the way the board draws its role', () => {
    const aura = renderSection('moonboard', MOON_FRAMES);
    expect(markerOf(aura, 'STARTING').getAttribute('data-color')).toBe('#44FF44');
    expect(markerOf(aura, 'HAND').getAttribute('data-color')).toBe('#4DF5FD');
    expect(markerOf(aura, 'FINISH').getAttribute('data-color')).toBe('#FF3333');
    cleanup();
    harness.look = { mode: 'classic', roleGlyphs: false };
    harness.colors = { FINISH: '#123456' };
    const classic = renderSection('moonboard', MOON_FRAMES);
    expect(markerOf(classic, 'HAND').getAttribute('data-color')).toBe('#4444FF');
    expect(markerOf(classic, 'FINISH').getAttribute('data-color')).toBe('#123456');
  });

  describe('marker glyphs', () => {
    const SHAPES: HoldShapeOverrides = { STARTING: 'triangle-up', HAND: 'diamond', FINISH: 'square', FOOT: 'octagon' };

    it("draws the climber's marker shapes in classic, the octagon as a hexagon", () => {
      harness.look = { mode: 'classic', roleGlyphs: false };
      harness.shapes = SHAPES;
      const view = renderSection('moonboard', MOON_ALL_ROLES);
      expect(markerOf(view, 'STARTING').textContent).toBe('▲');
      expect(markerOf(view, 'HAND').textContent).toBe('◆');
      expect(markerOf(view, 'FINISH').textContent).toBe('■');
      // No Apple system font has the black octagon, so it draws as a hexagon.
      expect(markerOf(view, 'FOOT').textContent).toBe('⬢');
    });

    it('draws a dot for every role in Aura, which ignores marker shapes', () => {
      harness.shapes = SHAPES;
      const view = renderSection('moonboard', MOON_ALL_ROLES);
      for (const role of ['STARTING', 'HAND', 'FINISH', 'FOOT']) expect(markerOf(view, role).textContent).toBe('●');
    });

    it("draws Aura's role glyphs when the climber turned them on", () => {
      harness.look = { mode: 'aura', roleGlyphs: true };
      harness.shapes = SHAPES;
      const view = renderSection('moonboard', MOON_ALL_ROLES);
      expect(markerOf(view, 'STARTING').textContent).toBe('━');
      expect(markerOf(view, 'HAND').textContent).toBe('┃');
      expect(markerOf(view, 'FINISH').textContent).toBe('✕');
      expect(markerOf(view, 'FOOT').textContent).toBe('○');
    });

    it('drops the shapes an older renderer refuses, as the board does, and keeps the colours', () => {
      harness.look = { mode: 'classic', roleGlyphs: false };
      harness.shapes = SHAPES;
      harness.colors = { FINISH: '#123456' };
      const view = renderSection('moonboard', MOON_ALL_ROLES);
      expect(markerOf(view, 'STARTING').textContent).toBe('▲');
      // The renderer refuses the climber's marker signature after the line drew.
      act(() => markRenderSignatureUnsupported('stored-markers'));
      for (const role of ['STARTING', 'HAND', 'FINISH', 'FOOT']) expect(markerOf(view, role).textContent).toBe('●');
      expect(markerOf(view, 'FINISH').getAttribute('data-color')).toBe('#123456');
    });

    it('picks the glyph from the mode alone', () => {
      expect(markerGlyph('HAND', 'square', { mode: 'classic', roleGlyphs: false })).toBe('■');
      expect(markerGlyph('HAND', 'square', { mode: 'aura', roleGlyphs: false })).toBe('●');
      expect(markerGlyph('FINISH', 'square', { mode: 'aura', roleGlyphs: true })).toBe('✕');
    });
  });

  describe('marker chips', () => {
    it('gives every MoonBoard role colour at least 3:1 on its chip, classic and Aura alike', () => {
      for (const [code, stateInfo] of Object.entries(HOLD_STATE_MAP.moonboard)) {
        if (!['STARTING', 'HAND', 'FINISH', 'FOOT'].includes(stateInfo.name)) continue;
        for (const mode of ['classic', 'aura'] as const) {
          const color = getHoldDisplayColor(stateInfo, mode);
          const ratio = contrastRatio(color, markerChipColor(color));
          expect(ratio, `${code} ${mode} ${color}`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it('sits every default role colour on the dark field, where it reaches 3:1', () => {
      for (const color of ['#44FF44', '#00DD00', '#4DF5FD', '#00FFFF', '#FF3333', '#FF0000', '#FF00FF', '#FFAA00']) {
        expect(markerChipColor(color)).toBe(BOARD_FIELD_COLORS.dark);
      }
    });

    it('sits a dark marker on the light field instead', () => {
      // A pure blue and a near-black colour a climber could pick.
      expect(markerChipColor('#0000FF')).toBe(BOARD_FIELD_COLORS.light);
      expect(markerChipColor('#101010')).toBe(BOARD_FIELD_COLORS.light);
    });

    it('paints each marker on its chip in both themes alike', () => {
      harness.colors = { HAND: '#101010' };
      const view = renderSection('moonboard', MOON_FRAMES);
      const startChip = markerOf(view, 'STARTING').parentElement;
      const handChip = markerOf(view, 'HAND').parentElement;
      expect(startChip?.getAttribute('data-style')).toContain(`"backgroundColor":"${BOARD_FIELD_COLORS.dark}"`);
      expect(handChip?.getAttribute('data-style')).toContain(`"backgroundColor":"${BOARD_FIELD_COLORS.light}"`);
    });
  });
});
