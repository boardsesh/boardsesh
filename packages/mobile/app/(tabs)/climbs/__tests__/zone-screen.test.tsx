// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import type { HoldsFilter, ZoneBoxInput } from '@boardsesh/shared-schema';

const track = vi.hoisted(() => vi.fn());
const haptics = vi.hoisted(() => ({ selection: vi.fn() }));
const emitZoneFilterSelection = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
// Mutable across tests so each can seed its own route params.
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));

// A 1000x1000 board over a 100x100 grid (spacing 10). buildDefaultZone → inner
// 60% = {20,80,20,80}. Hold 1 sits at grid (50,50) → inside; hold 2 at (5,5) →
// outside, so the allHolds prune must drop it.
const BOARD_HOLDS = vi.hoisted(() => ({
  holdTargets: [
    { id: 1, cx: 500, cy: 500, r: 10 },
    { id: 2, cx: 50, cy: 950, r: 10 },
  ],
  boardWidth: 1000,
  boardHeight: 1000,
  edgeLeft: 0,
  edgeRight: 100,
  edgeBottom: 0,
  edgeTop: 100,
  family: 'aurora' as const,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => ({ back: routerBack }),
  // Route the focus effect through a real useEffect so its cleanup (the handoff
  // emit) fires on unmount — matching useFocusEffect's blur/unmount behaviour.
  useFocusEffect: (effect: () => void | (() => void)) => {
    useEffect(() => effect(), [effect]);
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Heavy native children → inert stand-ins; we drive the screen via the mode
// control + buttons, not the actual board.
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title?: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-button': title ?? '' }, title),
}));
vi.mock('../../../../src/components/GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/components/search/InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: () => createElement('div', { 'data-board': 'true' }),
}));
vi.mock('../../../../src/components/search/ZoneOverlay', () => ({
  ZoneOverlay: () => createElement('div', { 'data-overlay': 'true' }),
}));

type SegmentMockProps = {
  options: ReadonlyArray<{ key: string; label: string }>;
  selectedKey: string;
  onSelect: (key: string) => void;
};
vi.mock('../../../../src/components/SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect }: SegmentMockProps) =>
    createElement(
      'div',
      { 'data-selected-key': selectedKey },
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, 'data-segment': option.key, onClick: () => onSelect(option.key) },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#000', elevatedSurface: '#111', fill: '#222', secondaryLabel: '#999' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../../src/lib/create-board-holds', () => ({
  getCreateBoardHolds: () => BOARD_HOLDS,
}));
vi.mock('../../../../src/lib/zone-filter-handoff', () => ({
  emitZoneFilterSelection: (selection: unknown) => emitZoneFilterSelection(selection),
}));
vi.mock('../../../../src/lib/analytics', () => ({
  track: (name: string, props?: Record<string, unknown>) => track(name, props),
}));
vi.mock('../../../../src/lib/haptics', () => ({ hapticSelection: () => haptics.selection() }));
vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16 },
  overlays: { scrim: 'rgba(0,0,0,0.4)' },
}));

import ZoneFilterScreen from '../zone';

// Kilter layout 1 resolves to "Kilter Board Original" via getLayout — the fix
// under test replaces the wrong family-name (`kilter`) boardLayout value.
const KILTER_ORIGINAL_LAYOUT_NAME = 'Kilter Board Original';

function baseParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    boardName: 'kilter',
    layoutId: '1',
    sizeId: '10',
    setIds: '1',
    angle: '40',
    ...overrides,
  };
}

describe('ZoneFilterScreen', () => {
  beforeEach(() => {
    track.mockClear();
    haptics.selection.mockClear();
    emitZoneFilterSelection.mockClear();
    routerBack.mockClear();
    routeParams.current = baseParams();
  });

  it('shows the Add-a-region affordance when no zone is set yet', () => {
    const { container } = render(<ZoneFilterScreen />);
    expect(container.querySelector('[data-button="mobile.zoneFilter.enable"]')).not.toBeNull();
    // No mode island until a zone exists.
    expect(container.querySelector('[data-segment="allHolds"]')).toBeNull();
  });

  it('enabling a zone logs the resolved layout NAME as boardLayout (not the family)', () => {
    const { container } = render(<ZoneFilterScreen />);
    fireEvent.click(container.querySelector('[data-button="mobile.zoneFilter.enable"]') as HTMLButtonElement);
    expect(track).toHaveBeenCalledWith('Search Zone Enabled', {
      boardLayout: KILTER_ORIGINAL_LAYOUT_NAME,
      zoneMode: 'allHolds',
    });
    // Regression guard: it must NOT be the board family name.
    expect(track).not.toHaveBeenCalledWith('Search Zone Enabled', expect.objectContaining({ boardLayout: 'kilter' }));
  });

  it('clearing a zone logs Search Zone Cleared with the layout name', () => {
    routeParams.current = baseParams({
      zoneBox: JSON.stringify({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
      zoneMode: 'allHolds',
    });
    const { container } = render(<ZoneFilterScreen />);
    fireEvent.click(container.querySelector('[data-button="mobile.zoneFilter.clearZone"]') as HTMLButtonElement);
    expect(track).toHaveBeenCalledWith('Search Zone Cleared', { boardLayout: KILTER_ORIGINAL_LAYOUT_NAME });
  });

  it('switching to allHolds prunes out-of-zone hold filters before handing them back', () => {
    const startZone: ZoneBoxInput = { edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 };
    // Hold 1 sits inside the zone, hold 2 outside — only hold 1 survives the prune.
    const startHolds: HoldsFilter = { 1: { HAND: 'include' }, 2: { FOOT: 'include' } };
    routeParams.current = baseParams({
      zoneBox: JSON.stringify(startZone),
      // Start in anyHold so flipping to allHolds is what triggers the prune.
      zoneMode: 'anyHold',
      holdsFilter: JSON.stringify(startHolds),
    });
    const { container, unmount } = render(<ZoneFilterScreen />);

    fireEvent.click(container.querySelector('[data-segment="allHolds"]') as HTMLButtonElement);

    expect(track).toHaveBeenCalledWith('Search Zone Mode Changed', {
      boardLayout: KILTER_ORIGINAL_LAYOUT_NAME,
      zoneMode: 'allHolds',
    });

    // The focus-effect cleanup hands the current (pruned) selection back. The
    // out-of-zone hold 2 must be gone; hold 1 stays.
    unmount();
    const selection = emitZoneFilterSelection.mock.calls.at(-1)?.[0] as {
      zoneMode: string;
      holdsFilter?: HoldsFilter;
    };
    expect(selection.zoneMode).toBe('allHolds');
    expect(selection.holdsFilter).toEqual({ 1: { HAND: 'include' } });
  });

  it('hands the current selection back to the sheet when the screen loses focus', () => {
    routeParams.current = baseParams({
      zoneBox: JSON.stringify({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
      zoneMode: 'allHolds',
    });
    const { unmount } = render(<ZoneFilterScreen />);
    unmount();
    expect(emitZoneFilterSelection).toHaveBeenCalled();
    const selection = emitZoneFilterSelection.mock.calls.at(-1)?.[0] as { zoneBox: ZoneBoxInput | null };
    expect(selection.zoneBox).toEqual({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 });
  });

  it('Done pops the screen', () => {
    const { container } = render(<ZoneFilterScreen />);
    const doneButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'mobile.filter.done',
    ) as HTMLButtonElement;
    fireEvent.click(doneButton);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  // Route params arrive as strings from the navigator and can be malformed
  // (manual deep link, stale handoff, the "null" string the sheet sends for an
  // empty zone). The parse helpers must fall back to safe defaults, never crash.
  describe('malformed route params', () => {
    it('treats the literal "null" zoneBox string as no zone', () => {
      routeParams.current = baseParams({ zoneBox: 'null' });
      const { container } = render(<ZoneFilterScreen />);
      // No zone → the add-a-region affordance, no mode island.
      expect(container.querySelector('[data-button="mobile.zoneFilter.enable"]')).not.toBeNull();
      expect(container.querySelector('[data-segment="allHolds"]')).toBeNull();
    });

    it('treats garbage JSON in zoneBox as no zone instead of crashing', () => {
      routeParams.current = baseParams({ zoneBox: '{not valid json' });
      const { container } = render(<ZoneFilterScreen />);
      expect(container.querySelector('[data-button="mobile.zoneFilter.enable"]')).not.toBeNull();
      expect(container.querySelector('[data-segment="allHolds"]')).toBeNull();
    });

    it('treats a zoneBox with non-numeric edges as no zone', () => {
      routeParams.current = baseParams({
        zoneBox: JSON.stringify({ edgeLeft: 'x', edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
      });
      const { container } = render(<ZoneFilterScreen />);
      expect(container.querySelector('[data-button="mobile.zoneFilter.enable"]')).not.toBeNull();
    });

    it('falls back to allHolds for an unrecognised zoneMode value', () => {
      routeParams.current = baseParams({
        zoneBox: JSON.stringify({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
        zoneMode: 'bananas',
      });
      const { container } = render(<ZoneFilterScreen />);
      // The mode island renders with the safe-default mode selected.
      const island = container.querySelector('[data-selected-key]');
      expect(island?.getAttribute('data-selected-key')).toBe('allHolds');
    });

    it('treats garbage JSON in holdsFilter as an empty filter', () => {
      routeParams.current = baseParams({
        zoneBox: JSON.stringify({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
        // Start in anyHold so flipping to allHolds runs the prune over the
        // (defaulted-empty) holds filter and hands an empty object back.
        zoneMode: 'anyHold',
        holdsFilter: 'not-json',
      });
      const { container, unmount } = render(<ZoneFilterScreen />);
      fireEvent.click(container.querySelector('[data-segment="allHolds"]') as HTMLButtonElement);
      unmount();
      const selection = emitZoneFilterSelection.mock.calls.at(-1)?.[0] as { holdsFilter?: HoldsFilter };
      expect(selection.holdsFilter).toEqual({});
    });

    it('treats a JSON-array holdsFilter as an empty filter', () => {
      routeParams.current = baseParams({
        zoneBox: JSON.stringify({ edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 }),
        zoneMode: 'anyHold',
        holdsFilter: JSON.stringify([1, 2, 3]),
      });
      const { container, unmount } = render(<ZoneFilterScreen />);
      fireEvent.click(container.querySelector('[data-segment="allHolds"]') as HTMLButtonElement);
      unmount();
      const selection = emitZoneFilterSelection.mock.calls.at(-1)?.[0] as { holdsFilter?: HoldsFilter };
      expect(selection.holdsFilter).toEqual({});
    });
  });
});
