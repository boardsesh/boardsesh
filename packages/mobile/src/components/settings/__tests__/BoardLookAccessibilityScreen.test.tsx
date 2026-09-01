// @vitest-environment jsdom
//
// The Classic-gating guard for the Board look "Accessibility" leaf.
//
// Marker shape, brush and size only draw in the Classic render, so they appear
// only when the drawing is KNOWN to be Classic — not merely resolving that way.
// `resolveEffectiveRenderSettings` falls back to Classic while the capability
// probe is unanswered, so keying off the effective mode alone flashed shape
// controls at a climber on the Boardsesh drawing for as long as that answer
// took. Classic is certain in exactly two cases: they chose it, or the installed
// binary cannot draw the other one.
//
// Inherited from the old single-screen suite (BoardLookSettingsScreen), which
// this replaces. Its other cases moved to pure model tests — see
// board-look-model.test.ts, custom-look-model.test.ts and
// use-board-look-settings.test.tsx — which assert the same behaviour without a
// renderer or a wall of mocks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardRenderSettings, EffectiveBoardRenderSettings } from '../../../lib/board-render-settings';

type SegmentedControlOption = { key: string; label: string };
type SegmentedControlMockProps = {
  options: SegmentedControlOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
  disabledKeys?: ReadonlySet<string>;
  accessibilityLabel?: string;
};

// Literal copies of the module's own defaults, not imports: `vi.hoisted()`
// initializers run before the top-level imports below are bound, so reading
// an imported const in here would hit the temporal dead zone. The real
// defaults are asserted against directly in board-render-settings.test.ts;
// this file only needs a stable, valid BoardseshRenderSettings shape to seed
// state that `setState()` immediately overwrites per test anyway.
const TEST_DEFAULT_BOARDSESH_SETTINGS = {
  glowFalloff: 'default',
  glowReach: 1,
  plateauShare: 0.4,
  veil: 'auto',
  veilOpacity: 0.6,
  markStyle: 'glow',
  fillOpacity: 0.55,
  softDisc: false,
  smallHoldBoost: true,
  ledDots: true,
  roleGlyphs: false,
  thumbnailStyle: 'fill',
} as const;

const boardRenderSettingsState = vi.hoisted(() => ({
  settings: { mode: 'default', boardsesh: {} } as BoardRenderSettings,
  setMode: vi.fn(),
  setBoardseshField: vi.fn(),
  reset: vi.fn(),
}));

const effectiveRenderState = vi.hoisted(() => ({
  effectiveRenderSettings: {} as EffectiveBoardRenderSettings,
  boardseshRendererAvailable: true as boolean | null,
}));

const holdColorOverridesState = vi.hoisted(() => ({
  overrides: {},
  shapes: {},
  brushThickness: 1,
  shapeSize: 1,
  loaded: true,
  signature: 'default',
  renderSignature: 'default',
  setRoleOverride: vi.fn(),
  setRoleShapeOverride: vi.fn(),
  setRoleMarkerOverride: vi.fn(),
  setBrushThickness: vi.fn(),
  setShapeSize: vi.fn(),
  setOverrides: vi.fn(),
  resetOverrides: vi.fn(),
}));

const segmentedControlCalls = vi.hoisted(() => ({ byLabel: new Map<string, SegmentedControlMockProps>() }));

// The board-look carousel is exercised by its own suite; here it is a stub that
// records what the screen handed it, so these cases stay about which SECTIONS
// the screen shows rather than about rendering board art.
const carouselCalls = vi.hoisted(() => ({
  last: null as { optionIds: string[]; selectedId: string; onSelect: (id: string) => void } | null,
}));
const trackBoardLookApplied = vi.hoisted(() => vi.fn());
// The palette rail is exercised by its own suite; here the stub records what the
// section handed it, so a case can press a card without mounting board art.
const paletteCarouselCalls = vi.hoisted(() => ({
  last: null as { selectedId: string; onSelect: (id: string) => void } | null,
}));
const customHoldColors = vi.hoisted(() => ({
  load: vi.fn(async () => null as Record<string, string> | null),
  remember: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
}));
const applyBoardLookOption = vi.hoisted(() => vi.fn(async () => {}));

const boardPreviewState = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'ready' | 'unavailable',
  preview: {
    frames: 'p1r12',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    boardWidth: 1080,
    boardHeight: 1350,
  } as unknown,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  // Something in the render tree reaches `theme/ios-colors.ts`, which reads
  // `Platform.OS` at module top level (outside any component body) — needed
  // even though nothing in this suite exercises a platform branch directly.
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      accent: '#6D28D9',
      background: '#ffffff',
      fill: '#eeeeee',
      label: '#000000',
      secondaryBackground: '#f5f5f5',
      secondaryLabel: '#888888',
      separator: '#cccccc',
    },
  }),
}));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));

vi.mock('../../../hooks/use-native-climb-render', () => ({
  useEffectiveBoardRenderSettings: () => effectiveRenderState,
  useBoardRenderFlags: () => ({}),
}));

vi.mock('../../../lib/board-render-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/board-render-settings')>();
  return { ...actual, useBoardRenderSettings: () => boardRenderSettingsState };
});

vi.mock('../../../lib/hold-color-overrides', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/hold-color-overrides')>();
  return { ...actual, useHoldColorOverrides: () => holdColorOverridesState };
});

vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: undefined }) }));
vi.mock('../../../lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: () => ({ data: undefined }),
}));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../../hooks/use-board-preview-climb', () => ({
  BOARD_PREVIEW_RENDER_WIDTH: 600,
  useBoardPreviewClimb: () => boardPreviewState,
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-testid': 'board-image' }),
}));
vi.mock('../../board-look/BoardLookCarousel', () => ({
  BoardLookCarousel: (props: { options: { id: string }[]; selectedId: string; onSelect: (id: string) => void }) => {
    carouselCalls.last = {
      optionIds: props.options.map((option) => option.id),
      selectedId: props.selectedId,
      onSelect: props.onSelect,
    };
    return createElement('div', { 'data-testid': 'board-look-carousel' });
  },
}));
// The colour-vision palette rail is exercised by its own suite; here it is a
// stub, so these cases stay about which SECTIONS the screen shows rather than
// about mounting six FlashList rows of board art.
vi.mock('../../board-look/PaletteCarousel', () => ({
  PaletteCarousel: (props: { selectedId: string; onSelect: (id: string) => void }) => {
    paletteCarouselCalls.last = { selectedId: props.selectedId, onSelect: props.onSelect };
    return createElement('div', { 'data-testid': 'palette-carousel' });
  },
}));
vi.mock('../../../lib/board-render/custom-hold-colors', () => ({
  loadCustomHoldColors: customHoldColors.load,
  rememberCustomHoldColors: customHoldColors.remember,
  clearCustomHoldColors: customHoldColors.clear,
}));
vi.mock('../../../lib/board-render/board-look-analytics', () => ({ trackBoardLookApplied }));
vi.mock('../../../lib/board-render/custom-board-look', () => ({
  loadCustomBoardLook: async () => null,
  rememberCustomBoardLook: async () => {},
  clearCustomBoardLook: async () => {},
}));
vi.mock('../../../lib/board-render/board-look-options', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/board-render/board-look-options')>()),
  applyBoardLookOption,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-testid': 'icon' }) }));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress?: () => void }) =>
    createElement(
      'button',
      { onClick: onPress },
      createElement('span', { key: 'title' }, title),
      subtitle ? createElement('span', { key: 'subtitle' }, subtitle) : null,
    ),
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h3', null, title),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: (props: SegmentedControlMockProps) => {
    if (props.accessibilityLabel) segmentedControlCalls.byLabel.set(props.accessibilityLabel, props);
    return createElement(
      'div',
      { role: 'group', 'aria-label': props.accessibilityLabel },
      props.options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            disabled: props.disabledKeys?.has(option.key) ?? false,
            onClick: () => props.onSelect(option.key),
          },
          option.label,
        ),
      ),
    );
  },
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    description?: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => createElement('button', { onClick: () => onValueChange(!value) }, label),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ visible, children, footer }: { visible?: boolean; children?: ReactNode; footer?: ReactNode }) =>
    visible ? createElement('div', { 'data-testid': 'modal-sheet' }, children, footer) : null,
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-testid': 'board-image' }),
}));
vi.mock('../../board-renderer/HoldMarkerShape', () => ({
  HoldMarkerShapeSvg: () => createElement('div', { 'data-testid': 'marker-shape' }),
}));
vi.mock('../OkhslColorPicker', () => ({
  OkhslColorPicker: () => createElement('div', { 'data-testid': 'color-picker' }),
}));

const { BoardLookAccessibilityScreen } = await import('../board-look/BoardLookAccessibilityScreen');

function setState(params: {
  mode: BoardRenderSettings['mode'];
  effectiveMode: 'classic' | 'aura';
  boardseshRendererAvailable: boolean | null;
  /** Knobs off their preset values, for the "already custom" case. */
  boardsesh?: Partial<BoardRenderSettings['boardsesh']>;
}) {
  boardRenderSettingsState.settings = {
    mode: params.mode,
    boardsesh: { ...TEST_DEFAULT_BOARDSESH_SETTINGS, ...params.boardsesh },
  };
  effectiveRenderState.effectiveRenderSettings = {
    mode: params.effectiveMode,
    glowFalloff: 'soft',
    glowFalloffSource: 'default',
    boardsesh: TEST_DEFAULT_BOARDSESH_SETTINGS,
    rendererAvailable: params.boardseshRendererAvailable === true,
  };
  effectiveRenderState.boardseshRendererAvailable = params.boardseshRendererAvailable;
}

afterEach(() => {
  cleanup();
  segmentedControlCalls.byLabel.clear();
  vi.clearAllMocks();
  carouselCalls.last = null;
  paletteCarouselCalls.last = null;
  boardPreviewState.status = 'ready';
  // Reset the preview too, not just the status: the "no board" case nulls it,
  // and leaving it null would silently hide the carousel from every later case.
  boardPreviewState.preview = {
    frames: 'p1r12',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    boardWidth: 1080,
    boardHeight: 1350,
  };
});

describe('the Accessibility leaf — a climber who chose Classic', () => {
  it('offers the marker shape controls, because Classic is what draws them', () => {
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookAccessibilityScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).not.toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).not.toBeNull();
    // No "these only apply to Classic" note — they do apply, right now.
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).toBeNull();
  });

  it('keeps the colour controls, which apply in every drawing', () => {
    // The colour-vision palette rail and the four hold-role rows are the colour
    // half of this screen, and neither is Classic-only — a Boardsesh render
    // draws the climber's colours too. This case used to assert on the
    // "Colour-vision palettes" chip block, which the rail replaced.
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    const { queryByText, queryByTestId } = render(<BoardLookAccessibilityScreen />);

    expect(queryByTestId('palette-carousel')).not.toBeNull();
    expect(queryByText('mobile.more.accessibility.roles.starting')).not.toBeNull();
  });
});

describe('the Accessibility leaf — a climber on the Boardsesh drawing', () => {
  it('hides the marker shape controls and explains why', () => {
    setState({ mode: 'aura', effectiveMode: 'aura', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookAccessibilityScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).toBeNull();
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).not.toBeNull();
  });
});

describe('the Accessibility leaf — the capability probe has not answered', () => {
  it('hides the marker shape controls for a climber on the Boardsesh drawing', () => {
    // The effective mode says Classic here only because the probe has not come
    // back. Showing shape rows on that basis would flash controls that are about
    // to become irrelevant.
    setState({ mode: 'aura', effectiveMode: 'classic', boardseshRendererAvailable: null });
    const { queryByText } = render(<BoardLookAccessibilityScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).toBeNull();
  });

  it('shows them once the probe says this binary cannot draw the other mode', () => {
    setState({ mode: 'aura', effectiveMode: 'classic', boardseshRendererAvailable: false });
    const { queryByText } = render(<BoardLookAccessibilityScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).not.toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).not.toBeNull();
  });
});

describe('the Accessibility leaf — remembering the climber’s own colours', () => {
  // What makes "try a palette, come back to my own colours" work: a manual edit
  // is mirrored aside, and a palette apply is NOT — mirroring one would
  // overwrite the very colours the Custom card exists to hand back.
  it('mirrors a hand-picked colour aside when the picker is saved', () => {
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    const { getByText } = render(<BoardLookAccessibilityScreen />);

    fireEvent.click(getByText('mobile.more.accessibility.roles.starting').closest('button')!);
    fireEvent.click(getByText('mobile.more.accessibility.save'));

    expect(holdColorOverridesState.setRoleMarkerOverride).toHaveBeenCalled();
    expect(customHoldColors.remember).toHaveBeenCalledTimes(1);
  });

  it('does not mirror a palette, which would destroy what Custom gives back', () => {
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    render(<BoardLookAccessibilityScreen />);

    act(() => paletteCarouselCalls.last?.onSelect('deuteranopia'));

    // All four roles written — the same path a manual pick takes, so it reaches
    // the board's LEDs — and nothing mirrored.
    expect(holdColorOverridesState.setRoleOverride).toHaveBeenCalledTimes(4);
    expect(customHoldColors.remember).not.toHaveBeenCalled();
  });

  it('forgets them when the climber resets the hold markers', () => {
    holdColorOverridesState.renderSignature = 'starting-00ff00';
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    const { getByText } = render(<BoardLookAccessibilityScreen />);

    fireEvent.click(getByText('mobile.more.accessibility.resetAll'));

    expect(holdColorOverridesState.resetOverrides).toHaveBeenCalledTimes(1);
    expect(customHoldColors.clear).toHaveBeenCalledTimes(1);
    holdColorOverridesState.renderSignature = 'default';
  });
});
