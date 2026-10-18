// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { coordinateToHoldId, type MoonBoardCoordinate } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldColorOverrides, HoldShapeOverrides } from '../../../lib/hold-color-overrides';

const harness = vi.hoisted(() => ({
  look: { mode: 'aura' as 'aura' | 'classic', roleGlyphs: false },
  colors: {} as HoldColorOverrides,
  shapes: {} as HoldShapeOverrides,
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
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': testID, 'data-style': JSON.stringify(style), 'aria-label': accessibilityLabel },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({ title, summary, children }: { title: string; summary?: ReactNode; children?: ReactNode }) =>
    createElement('section', { 'data-title': title }, createElement('header', null, summary), children),
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
  useHoldColorOverrides: () => ({ overrides: harness.colors, shapes: harness.shapes }),
}));

const { ActiveHoldsSection, markerChipColor, markerGlyph } = await import('../ActiveHoldsSection');

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
const KILTER_FRAMES = 'p1r42p2r42p3r43p4r44p5r45p6r45p7r45';

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

beforeEach(() => {
  harness.look = { mode: 'aura', roleGlyphs: false };
  harness.colors = {};
  harness.shapes = {};
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

  it('draws the collapsed line as each marker followed by its holds', () => {
    const moon = renderSection('moonboard', MOON_FRAMES);
    expect(moon.getByTestId('active-holds-line').textContent).toBe('●B5●F8 K8 F10 H13 I14●J18');
    cleanup();
    const kilter = renderSection('kilter', KILTER_FRAMES);
    expect(kilter.getByTestId('active-holds-line').textContent).toBe('●2●1●1●3');
  });

  it('cuts only the role with the most holds short when the line runs out of room', () => {
    const view = renderSection('moonboard', MOON_FRAMES);
    const groups = [...view.getByTestId('active-holds-line').children];
    const shrinking = groups.filter((group) => group.getAttribute('data-style')?.includes('"flexShrink":1'));
    expect(shrinking).toHaveLength(1);
    expect(shrinking[0]?.textContent).toBe('●F8 K8 F10 H13 I14');
  });

  it('counts each role on a board without wall coordinates', () => {
    const view = renderSection('kilter', KILTER_FRAMES);
    expect(rowText(view, 'STARTING')).toBe('●Start2');
    expect(rowText(view, 'HAND')).toBe('●Hand1');
    expect(rowText(view, 'FOOT')).toBe('●Foot3');
  });

  it('reads every row out in full', () => {
    const moon = renderSection('moonboard', MOON_FRAMES);
    expect(moon.getByTestId('active-holds-row-HAND').getAttribute('aria-label')).toBe('Hand: F8, K8, F10, H13, I14');
    cleanup();
    const kilter = renderSection('kilter', KILTER_FRAMES);
    expect(kilter.getByTestId('active-holds-row-FOOT').getAttribute('aria-label')).toBe('Foot: 3');
  });

  it('says so for a climb with no holds lit', () => {
    const view = renderSection('kilter', '');
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
      const view = renderSection('kilter', 'p1r42p3r43p4r44p5r45');
      expect(markerOf(view, 'STARTING').textContent).toBe('▲');
      expect(markerOf(view, 'HAND').textContent).toBe('◆');
      expect(markerOf(view, 'FINISH').textContent).toBe('■');
      // No Apple system font has the black octagon, so it draws as a hexagon.
      expect(markerOf(view, 'FOOT').textContent).toBe('⬢');
    });

    it('draws a dot for every role in Aura, which ignores marker shapes', () => {
      harness.shapes = SHAPES;
      const view = renderSection('kilter', 'p1r42p3r43p4r44p5r45');
      for (const role of ['STARTING', 'HAND', 'FINISH', 'FOOT']) expect(markerOf(view, role).textContent).toBe('●');
    });

    it("draws Aura's role glyphs when the climber turned them on", () => {
      harness.look = { mode: 'aura', roleGlyphs: true };
      harness.shapes = SHAPES;
      const view = renderSection('kilter', 'p1r42p3r43p4r44p5r45');
      expect(markerOf(view, 'STARTING').textContent).toBe('━');
      expect(markerOf(view, 'HAND').textContent).toBe('┃');
      expect(markerOf(view, 'FINISH').textContent).toBe('✕');
      expect(markerOf(view, 'FOOT').textContent).toBe('○');
    });

    it('picks the glyph from the mode alone', () => {
      expect(markerGlyph('HAND', 'square', { mode: 'classic', roleGlyphs: false })).toBe('■');
      expect(markerGlyph('HAND', 'square', { mode: 'aura', roleGlyphs: false })).toBe('●');
      expect(markerGlyph('FINISH', 'square', { mode: 'aura', roleGlyphs: true })).toBe('✕');
    });
  });

  describe('marker chips', () => {
    it('sits every default role colour on the dark field, where it reaches 3:1', () => {
      for (const color of ['#44FF44', '#00DD00', '#4DF5FD', '#00FFFF', '#FF3333', '#FF0000', '#FF00FF', '#FFAA00']) {
        expect(markerChipColor(color)).toBe(BOARD_FIELD_COLORS.dark);
      }
    });

    it('sits a dark marker on the light field instead', () => {
      // Decoy's classic hand blue, and a near-black colour a climber could pick.
      expect(markerChipColor('#0000FF')).toBe(BOARD_FIELD_COLORS.light);
      expect(markerChipColor('#101010')).toBe(BOARD_FIELD_COLORS.light);
    });

    it('paints each marker on its chip in both themes alike', () => {
      harness.look = { mode: 'classic', roleGlyphs: false };
      const view = renderSection('decoy', 'p1r1p2r2');
      const startChip = markerOf(view, 'STARTING').parentElement;
      const handChip = markerOf(view, 'HAND').parentElement;
      expect(startChip?.getAttribute('data-style')).toContain(`"backgroundColor":"${BOARD_FIELD_COLORS.dark}"`);
      expect(handChip?.getAttribute('data-style')).toContain(`"backgroundColor":"${BOARD_FIELD_COLORS.light}"`);
    });
  });
});
