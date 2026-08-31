// @vitest-environment jsdom
//
// Section-visibility regression guard for the "Board look" screen (issue
// #2202): renders the whole screen with the settings store stubbed to each
// mode and asserts which rows exist. The screen is mode-gated in two places —
// the preset chip row (only in Boardsesh mode, keyed off the raw picker) and
// the Classic marker shape/brush/size rows (keyed off the EFFECTIVE mode, so a
// "Boardsesh" pick that the installed renderer can't honour still shows the
// Classic controls that actually apply). Glow & veil and Marks stay visible in
// every mode so a climber can tune Boardsesh before switching to it.
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

const { BoardLookSettingsScreen } = await import('../BoardLookSettingsScreen');

function setState(params: {
  mode: BoardRenderSettings['mode'];
  effectiveMode: 'classic' | 'boardsesh';
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

/** Tap the Custom card, which is what reveals the knobs and the Render control. */
function openCustom() {
  act(() => carouselCalls.last?.onSelect('custom'));
}

afterEach(() => {
  cleanup();
  segmentedControlCalls.byLabel.clear();
  vi.clearAllMocks();
  carouselCalls.last = null;
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

describe('BoardLookSettingsScreen — Classic mode', () => {
  it('shows the Classic marker rows and the look carousel, hides the renderer banner', () => {
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).not.toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).not.toBeNull();
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).toBeNull();
    // The carousel is NOT mode-gated any more: Classic is one of its cards, and
    // a climber sitting on Classic is exactly who benefits from seeing what the
    // alternatives look like on their own board.
    expect(queryByText('mobile.more.boardLook.presets.title')).not.toBeNull();
    expect(carouselCalls.last?.selectedId).toBe('classic');
    expect(queryByText('mobile.more.boardLook.rendererUnavailable.title')).toBeNull();
    // Glow & veil and Marks are not mode-gated — a climber can tune them
    // before ever switching out of Classic.
    // Glow & veil and Marks belong to Custom now — the screen leads with the
    // looks, and only opens up if you ask it to.
    expect(queryByText('mobile.more.boardLook.glowVeil.title')).toBeNull();
    expect(queryByText('mobile.more.boardLook.marks.title')).toBeNull();
    // Colour overrides stay visible in every mode.
    expect(queryByText('mobile.more.boardLook.accessibility.cvdPalette.title')).not.toBeNull();
    expect(queryByText('mobile.more.boardLook.resetAll')).not.toBeNull();
  });
});

describe('BoardLookSettingsScreen — Boardsesh mode (renderer available)', () => {
  it('shows the look carousel and the classic-only note, hides the Classic marker rows', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.boardLook.presets.title')).not.toBeNull();
    expect(carouselCalls.last?.optionIds).toEqual(['boardsesh', 'classic', 'subtle', 'max-contrast', 'bold', 'custom']);
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).not.toBeNull();
    expect(queryByText('mobile.more.accessibility.brush.title')).toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).toBeNull();
    expect(queryByText('mobile.more.boardLook.rendererUnavailable.title')).toBeNull();
  });
});

describe('BoardLookSettingsScreen — Boardsesh requested but the renderer cannot draw it', () => {
  it('shows the banner, disables the Boardsesh segment, and offers only the looks this build can draw', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'classic', boardseshRendererAvailable: false });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.boardLook.rendererUnavailable.title')).not.toBeNull();
    // Every Boardsesh card would be a classic render under another name on this
    // binary, so the carousel collapses rather than lying; the banner above
    // already explains why.
    expect(queryByText('mobile.more.boardLook.presets.title')).not.toBeNull();
    expect(carouselCalls.last?.optionIds).toEqual(['classic', 'custom']);
    // The marker rows are also gated on the EFFECTIVE mode, which fell back
    // to classic — they must come back, not stay hidden under a mode that
    // isn't actually rendering.
    expect(queryByText('mobile.more.accessibility.brush.title')).not.toBeNull();
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).toBeNull();

    openCustom();
    const modeControl = segmentedControlCalls.byLabel.get('mobile.more.boardLook.mode.title');
    expect(modeControl?.disabledKeys?.has('boardsesh')).toBe(true);
  });
});

describe('BoardLookSettingsScreen — a climber who has never chosen a mode', () => {
  function modeControl() {
    // The Render control lives behind Custom — the carousel covers mode choice
    // otherwise, and Classic is one of its cards.
    openCustom();
    return segmentedControlCalls.byLabel.get('mobile.more.boardLook.mode.title');
  }

  it('offers only the two real drawings — no Automatic', () => {
    // `Automatic` meant "defer to the rollout flag". With that flag retired it
    // resolves to Boardsesh every time, so it said the same thing as the
    // Boardsesh segment in a word that explained less.
    setState({ mode: 'default', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    expect(modeControl()?.options.map((option) => option.key)).toEqual(['classic', 'boardsesh']);
  });

  it('shows the drawing they are actually getting, without writing a choice', () => {
    // Their stored mode is still `default` — that is precisely who the one-time
    // board-look step targets, so rendering the control must not silently
    // convert them into someone who has answered.
    setState({ mode: 'default', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    expect(modeControl()?.selectedKey).toBe('boardsesh');
    expect(boardRenderSettingsState.setMode).not.toHaveBeenCalled();
  });

  it('reflects a fallback to Classic when the renderer cannot draw the other one', () => {
    setState({ mode: 'default', effectiveMode: 'classic', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    expect(modeControl()?.selectedKey).toBe('classic');
    expect(boardRenderSettingsState.setMode).not.toHaveBeenCalled();
  });
});

describe('BoardLookSettingsScreen — the capability probe has not answered', () => {
  it('hides the Classic marker rows for a climber on the Boardsesh drawing', () => {
    // The regression: `resolveEffectiveRenderSettings` falls back to Classic
    // while the probe is unanswered, so gating these rows on the EFFECTIVE mode
    // flashed shape / brush / size at someone who is on the Boardsesh drawing —
    // controls that draw nothing there.
    setState({ mode: 'boardsesh', effectiveMode: 'classic', boardseshRendererAvailable: null });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).toBeNull();
    expect(queryByText('mobile.more.accessibility.size.title')).toBeNull();
    expect(queryByText('mobile.more.boardLook.accessibility.classicOnlyNote')).not.toBeNull();
  });

  it('shows them once the probe says the binary cannot draw the other mode', () => {
    // Now Classic is certain, so the rows describe what is actually on screen.
    setState({ mode: 'boardsesh', effectiveMode: 'classic', boardseshRendererAvailable: false });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.accessibility.brush.title')).not.toBeNull();
  });

  it('still offers every look, and lets the carousel skeleton the ones it cannot draw yet', () => {
    // `null` is "not answered", not "unavailable": the cards stay on offer and
    // the carousel decides to skeleton them, rather than the screen dropping
    // options that will be drawable a moment later.
    setState({ mode: 'classic', effectiveMode: 'classic', boardseshRendererAvailable: null });
    render(<BoardLookSettingsScreen />);

    expect(carouselCalls.last?.optionIds).toContain('boardsesh');
    expect(carouselCalls.last?.selectedId).toBe('classic');
  });
});

describe('BoardLookSettingsScreen — no board to preview', () => {
  it('hides the carousel rather than showing empty cards', () => {
    // Nothing of the climber's own to draw, so five identical blank frames
    // would say nothing about five drawings.
    boardPreviewState.status = 'unavailable';
    boardPreviewState.preview = null;
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.boardLook.presets.title')).toBeNull();
    // The accessibility half does not depend on a preview and stays put.
    expect(queryByText('mobile.more.boardLook.accessibility.cvdPalette.title')).not.toBeNull();
  });
});

describe('BoardLookSettingsScreen — Reset all', () => {
  it('resets both the render settings store and the hold colour/shape overrides', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    const { getByText } = render(<BoardLookSettingsScreen />);

    fireEvent.click(getByText('mobile.more.boardLook.resetAll'));

    expect(boardRenderSettingsState.reset).toHaveBeenCalledTimes(1);
    expect(holdColorOverridesState.resetOverrides).toHaveBeenCalledTimes(1);
  });
});

describe('BoardLookSettingsScreen — picking a look from the carousel', () => {
  it('applies it and reports it as a settings-surface preset apply', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    carouselCalls.last?.onSelect('subtle');

    expect(applyBoardLookOption).toHaveBeenCalledWith('subtle');
    // `surface` is what tells the two homes of this carousel apart in the
    // funnel; without it a settings tweak reads as an onboarding decision.
    const [optionId, effective, context, surface] = trackBoardLookApplied.mock.calls[0];
    expect(optionId).toBe('subtle');
    expect(surface).toBe('settings');
    expect(context).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10 });
    // Reported post-apply: the event means "the common props now carry this preset".
    expect(effective.mode).toBe('boardsesh');
  });

  it('reports the Classic card as a mode change, not a preset', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    carouselCalls.last?.onSelect('classic');

    expect(applyBoardLookOption).toHaveBeenCalledWith('classic');
    const [optionId, effective] = trackBoardLookApplied.mock.calls[0];
    expect(optionId).toBe('classic');
    expect(effective.mode).toBe('classic');
  });
});

describe('BoardLookSettingsScreen — Custom', () => {
  it('reveals the knobs and the Render control when Custom is tapped', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookSettingsScreen />);
    expect(queryByText('mobile.more.boardLook.glowVeil.title')).toBeNull();

    openCustom();

    expect(queryByText('mobile.more.boardLook.glowVeil.title')).not.toBeNull();
    expect(queryByText('mobile.more.boardLook.marks.title')).not.toBeNull();
    expect(segmentedControlCalls.byLabel.get('mobile.more.boardLook.mode.title')).toBeDefined();
  });

  it('writes nothing when Custom is tapped', () => {
    // The climber's settings ARE the custom look. Applying anything here would
    // overwrite the very tuning the card exists to expose.
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    render(<BoardLookSettingsScreen />);

    openCustom();

    expect(applyBoardLookOption).not.toHaveBeenCalled();
    expect(trackBoardLookApplied).not.toHaveBeenCalled();
  });

  it('closes the knobs again when a real preset is picked', () => {
    setState({ mode: 'boardsesh', effectiveMode: 'boardsesh', boardseshRendererAvailable: true });
    const { queryByText } = render(<BoardLookSettingsScreen />);
    openCustom();
    expect(queryByText('mobile.more.boardLook.glowVeil.title')).not.toBeNull();

    act(() => carouselCalls.last?.onSelect('subtle'));

    expect(applyBoardLookOption).toHaveBeenCalledWith('subtle');
    expect(queryByText('mobile.more.boardLook.glowVeil.title')).toBeNull();
  });

  it('opens the knobs on its own for settings that match no preset', () => {
    // Nothing to reveal — they are already looking at a custom look, so hiding
    // the controls that produced it would strand them.
    setState({
      mode: 'boardsesh',
      effectiveMode: 'boardsesh',
      boardseshRendererAvailable: true,
      boardsesh: { glowReach: 1.77 },
    });
    const { queryByText } = render(<BoardLookSettingsScreen />);

    expect(queryByText('mobile.more.boardLook.glowVeil.title')).not.toBeNull();
    expect(carouselCalls.last?.selectedId).toBe('custom');
  });
});
