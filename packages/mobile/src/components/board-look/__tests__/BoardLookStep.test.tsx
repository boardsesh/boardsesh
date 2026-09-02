// @vitest-environment jsdom
//
// The invariant this file exists for: every `Board Look Step Shown` resolves to
// exactly ONE `Board Look Step Resolved`. A step that fired Shown and nothing
// else would read in the funnel as a climber who never arrived, rather than one
// who backed out — which is the opposite of what happened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const analytics = vi.hoisted(() => ({
  trackBoardLookApplied: vi.fn(),
  trackBoardLookStepShown: vi.fn(),
  trackBoardLookStepResolved: vi.fn(),
}));
const applyBoardLookOption = vi.hoisted(() => vi.fn(async () => {}));
const markTipSeenMock = vi.hoisted(() => vi.fn(async () => {}));
const carouselCtrl = vi.hoisted(() => ({
  onSelect: null as ((id: string) => void) | null,
  onCardSeen: null as ((id: string) => void) | null,
  optionIds: [] as string[],
  showDescriptions: undefined as boolean | undefined,
}));

vi.mock('react-native', () => ({
  // The rail slot reports its measured height through onLayout; the step draws
  // nothing into it until that lands, so the stub has to fire once.
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    onLayout?.({ nativeEvent: { layout: { height: 520, width: 402 } } });
    return createElement('div', null, children);
  },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  // The step swallows Android back (useBlockBack); here it only has to exist.
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', separator: '#C6C6C8' },
    brandColors: { primary: '#6D28D9' },
    variant: 'liquidGlass',
    textStyles: {
      title3: { fontSize: 20, lineHeight: 25 },
      subheadline: { fontSize: 15, lineHeight: 20 },
      caption1: { fontSize: 12, lineHeight: 16 },
    },
  }),
}));
vi.mock('../../../theme/variants', () => ({
  selectByVariant: (_v: string, spec: { liquidGlass: unknown }) => spec.liquidGlass,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../BoardLookCarousel', () => ({
  BoardLookCarousel: (props: {
    options: { id: string }[];
    onSelect: (id: string) => void;
    onCardSeen?: (id: string) => void;
    showDescriptions?: boolean;
  }) => {
    carouselCtrl.onSelect = props.onSelect;
    carouselCtrl.onCardSeen = props.onCardSeen ?? null;
    carouselCtrl.optionIds = props.options.map((option) => option.id);
    carouselCtrl.showDescriptions = props.showDescriptions;
    return createElement('div', { 'data-testid': 'carousel' });
  },
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({ useBoardRenderFlags: () => ({}) }));
// The step marks itself seen on an answer; the real module reaches AsyncStorage.
vi.mock('../../../lib/board-render/board-look-step-seen', () => ({ markBoardLookStepSeen: markTipSeenMock }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/board-render/board-look-analytics', () => analytics);
vi.mock('../../../lib/board-render/board-look-options', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/board-render/board-look-options')>()),
  applyBoardLookOption,
}));

const { BoardLookStep } = await import('../BoardLookStep');

const PREVIEW = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};

function renderStep(overrides: Partial<Parameters<typeof BoardLookStep>[0]> = {}) {
  const props = {
    accentColor: '#6D28D9',
    bodyColor: '#888888',
    backgroundColor: '#ffffff',
    preview: PREVIEW,
    boardseshRendererAvailable: true,
    onSaved: vi.fn(),
    onCustomize: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<BoardLookStep {...props} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  carouselCtrl.onSelect = null;
  carouselCtrl.onCardSeen = null;
});

afterEach(() => {
  cleanup();
});

describe('BoardLookStep', () => {
  it('reports the step as shown, with how many looks were offered', () => {
    renderStep();
    expect(analytics.trackBoardLookStepShown).toHaveBeenCalledOnce();
    expect(analytics.trackBoardLookStepShown.mock.calls[0][2]).toBe(carouselCtrl.optionIds.length);
  });

  describe('the one-shot "seen" flag', () => {
    // Issue #4961. Burning it on arrival meant a force-quit mid-step left
    // `mode: 'default'` stored AND the flag set, so the gate never asked again
    // and the new default was accepted in silence — the outcome a mandatory
    // step exists to prevent. Only an answer counts.
    it('is not written just because the step appeared', () => {
      renderStep();
      expect(markTipSeenMock).not.toHaveBeenCalled();
    });

    it('is not written when they leave without answering', () => {
      const { unmount } = renderStep();

      unmount();

      expect(markTipSeenMock).not.toHaveBeenCalled();
    });

    it('is written on a save', async () => {
      const { props, getByText } = renderStep();

      fireEvent.click(getByText('mobile.more.boardLook.intro.saveNamed'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());

      expect(markTipSeenMock).toHaveBeenCalledOnce();
    });

    it('is written when they choose Custom', async () => {
      const { props, getByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));
      fireEvent.click(getByText('mobile.more.boardLook.intro.customCta'));
      await vi.waitFor(() => expect(props.onCustomize).toHaveBeenCalled());

      expect(markTipSeenMock).toHaveBeenCalledOnce();
    });

    it('is written even when the settings write fails, so nobody is stranded', async () => {
      // The step has no exit. A storage failure must not turn that into a trap
      // — the flag is claimed before the write it records is attempted.
      applyBoardLookOption.mockRejectedValueOnce(new Error('disk full'));
      const { props, getByText } = renderStep();

      fireEvent.click(getByText('mobile.more.boardLook.intro.saveNamed'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());

      expect(markTipSeenMock).toHaveBeenCalledOnce();
    });
  });

  it('offers six looks and no per-card sentences', () => {
    // The order the product asks for, and the reason there is room for six: the
    // caption under each board is its name, nothing more.
    renderStep();
    expect(carouselCtrl.optionIds).toEqual([
      'aura',
      'aura-subtle',
      'modern-classic',
      'classic',
      'max-contrast',
      'custom',
    ]);
    expect(carouselCtrl.showDescriptions).toBe(false);
  });

  it('leads with the climber’s current look — the plain Aura card by default', () => {
    renderStep();
    expect(carouselCtrl.optionIds[0]).toBe('aura');
  });

  describe('resolves exactly once', () => {
    it('on save', async () => {
      const { props, getByText } = renderStep();

      fireEvent.click(getByText('mobile.more.boardLook.intro.saveNamed'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());

      expect(applyBoardLookOption).toHaveBeenCalledWith('aura');
      expect(analytics.trackBoardLookStepResolved).toHaveBeenCalledOnce();
      expect(analytics.trackBoardLookStepResolved.mock.calls[0][2]).toMatchObject({
        outcome: 'saved',
        selectedOption: 'aura',
      });
    });

    it('on an unmount with no choice at all', () => {
      const { unmount } = renderStep();

      unmount();

      // The nav-away exit. Without this the Shown would dangle.
      expect(analytics.trackBoardLookStepResolved).toHaveBeenCalledOnce();
      expect(analytics.trackBoardLookStepResolved.mock.calls[0][2]).toMatchObject({ outcome: 'skipped' });
    });

    it('and not a second time when the unmount follows a save', async () => {
      const { props, getByText, unmount } = renderStep();

      fireEvent.click(getByText('mobile.more.boardLook.intro.saveNamed'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());
      unmount();

      expect(analytics.trackBoardLookStepResolved).toHaveBeenCalledOnce();
    });
  });

  describe('the Custom card', () => {
    it('switches the primary button to the set-up call to action', () => {
      const { getByText, queryByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));

      expect(queryByText('mobile.more.boardLook.intro.saveNamed')).toBeNull();
      expect(getByText('mobile.more.boardLook.intro.customCta')).toBeTruthy();
    });

    it('applies the plain Aura bundle and hands off to Board look', async () => {
      const { props, getByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));
      fireEvent.click(getByText('mobile.more.boardLook.intro.customCta'));
      await vi.waitFor(() => expect(props.onCustomize).toHaveBeenCalled());

      // They land on the configure screen already in Aura mode, so every
      // slider they touch changes something visible.
      expect(applyBoardLookOption).toHaveBeenCalledWith('custom');
      expect(props.onSaved).not.toHaveBeenCalled();
      expect(analytics.trackBoardLookStepResolved.mock.calls[0][2]).toMatchObject({ outcome: 'customized' });
    });

    it('reports the bundle it actually wrote, not the one its card previews', async () => {
      const { props, getByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));
      fireEvent.click(getByText('mobile.more.boardLook.intro.customCta'));
      await vi.waitFor(() => expect(props.onCustomize).toHaveBeenCalled());

      // The Custom card previews Aura Bold under a question mark but WRITES
      // the plain Aura bundle. Resolving the event from the card's preview
      // settings would file Aura Bold's plateau falloff under preset_id 'aura'
      // and drop every "Set it up" tap into the wrong arm of the glow-falloff
      // A/B.
      const [, effective] = analytics.trackBoardLookApplied.mock.calls[0];
      expect(effective.glowFalloff).toBe('soft');
      expect(effective.mode).toBe('aura');
    });
  });

  it('counts the distinct cards that actually came into view', async () => {
    const { props, getByText } = renderStep();

    carouselCtrl.onCardSeen?.('aura');
    carouselCtrl.onCardSeen?.('aura-subtle');
    carouselCtrl.onCardSeen?.('aura');
    fireEvent.click(getByText('mobile.more.boardLook.intro.saveNamed'));
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());

    // Distinct, not a tally of viewability callbacks — "took the default on
    // sight" and "swiped through, then chose" must stay tellable apart.
    expect(analytics.trackBoardLookStepResolved.mock.calls[0][2]).toMatchObject({ cardsViewed: 2 });
  });

  // Issue #4961: declining used to accept the new default in silence, which is
  // the one outcome this step exists to prevent. Its absence is the assertion.
  it('offers no way out beside the primary call to action', () => {
    const { container } = renderStep();

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    // Names the look rather than saying "this", so a climber reading only the
    // button — or hearing it read out — knows what they are committing to.
    expect(buttons[0]?.textContent).toBe('mobile.more.boardLook.intro.saveNamed');
  });
});
