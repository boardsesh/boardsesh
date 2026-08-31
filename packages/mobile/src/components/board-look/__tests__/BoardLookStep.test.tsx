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
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  // The step swallows Android back (useBlockBack); here it only has to exist.
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888' }, variant: 'liquidGlass' }),
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
  }) => {
    carouselCtrl.onSelect = props.onSelect;
    carouselCtrl.onCardSeen = props.onCardSeen ?? null;
    carouselCtrl.optionIds = props.options.map((option) => option.id);
    return createElement('div', { 'data-testid': 'carousel' });
  },
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({ useBoardRenderFlags: () => ({}) }));
// The step marks itself seen on mount; the real module reaches AsyncStorage.
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

  it('marks itself seen on arrival, so a force-quit still counts as asked', () => {
    // Written by the STEP, not the route: the flag means "this climber has been
    // asked", and a route that mounts with nothing to preview (or on a build
    // that cannot draw the mode) must not burn the one-time question.
    renderStep();
    expect(markTipSeenMock).toHaveBeenCalledOnce();
  });

  it('leads with the climber’s current look — the plain Boardsesh card by default', () => {
    renderStep();
    expect(carouselCtrl.optionIds[0]).toBe('boardsesh');
  });

  describe('resolves exactly once', () => {
    it('on save', async () => {
      const { props, getByText } = renderStep();

      fireEvent.click(getByText('mobile.more.boardLook.intro.save'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());

      expect(applyBoardLookOption).toHaveBeenCalledWith('boardsesh');
      expect(analytics.trackBoardLookStepResolved).toHaveBeenCalledOnce();
      expect(analytics.trackBoardLookStepResolved.mock.calls[0][2]).toMatchObject({
        outcome: 'saved',
        selectedOption: 'boardsesh',
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

      fireEvent.click(getByText('mobile.more.boardLook.intro.save'));
      await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalled());
      unmount();

      expect(analytics.trackBoardLookStepResolved).toHaveBeenCalledOnce();
    });
  });

  describe('the Custom card', () => {
    it('switches the primary button to the set-up call to action', () => {
      const { getByText, queryByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));

      expect(queryByText('mobile.more.boardLook.intro.save')).toBeNull();
      expect(getByText('mobile.more.boardLook.intro.customCta')).toBeTruthy();
    });

    it('applies the plain Boardsesh bundle and hands off to Board look', async () => {
      const { props, getByText } = renderStep();

      act(() => carouselCtrl.onSelect?.('custom'));
      fireEvent.click(getByText('mobile.more.boardLook.intro.customCta'));
      await vi.waitFor(() => expect(props.onCustomize).toHaveBeenCalled());

      // They land on the configure screen already in Boardsesh mode, so every
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

      // The Custom card previews `bold` under a question mark but WRITES the
      // boardsesh bundle. Resolving the event from the card's preview settings
      // would file bold's plateau falloff under preset_id 'boardsesh' and drop
      // every "Set it up" tap into the wrong arm of the glow-falloff A/B.
      const [, effective] = analytics.trackBoardLookApplied.mock.calls[0];
      expect(effective.glowFalloff).toBe('soft');
      expect(effective.mode).toBe('boardsesh');
    });
  });

  it('counts the distinct cards that actually came into view', async () => {
    const { props, getByText } = renderStep();

    carouselCtrl.onCardSeen?.('boardsesh');
    carouselCtrl.onCardSeen?.('subtle');
    carouselCtrl.onCardSeen?.('boardsesh');
    fireEvent.click(getByText('mobile.more.boardLook.intro.save'));
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
    expect(buttons[0]?.textContent).toBe('mobile.more.boardLook.intro.save');
  });
});
