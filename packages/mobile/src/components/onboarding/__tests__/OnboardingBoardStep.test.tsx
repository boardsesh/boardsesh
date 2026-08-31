// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const backHandlerCtrl = vi.hoisted(() => ({ handler: null as (() => boolean) | null, removed: false }));
const offlineStateCtrl = vi.hoisted(() => ({ state: 'off' as string }));
const carouselCtrl = vi.hoisted(() => ({
  items: [] as { key: string; title: string }[],
  onSelect: null as ((item: { key: string }) => void) | null,
  onDownload: null as ((item: { key: string }) => void) | null,
  downloadLabelFor: null as ((item: { key: string; title: string }) => string) | null,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandlerCtrl.handler = handler;
      return {
        remove: () => {
          backHandlerCtrl.removed = true;
        },
      };
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../board-discovery/BoardCarousel', () => ({
  BoardCarousel: (props: {
    items: { key: string; title: string }[];
    onSelect: (item: { key: string }) => void;
    onDownload?: (item: { key: string }) => void;
    downloadLabelFor?: (item: { key: string; title: string }) => string;
  }) => {
    carouselCtrl.items = props.items;
    carouselCtrl.onSelect = props.onSelect;
    carouselCtrl.onDownload = props.onDownload ?? null;
    carouselCtrl.downloadLabelFor = props.downloadLabelFor ?? null;
    return createElement('div', { 'data-testid': 'carousel' });
  },
}));
vi.mock('../../board-discovery/use-board-offline-state', () => ({
  useBoardOfflineState: () => () => offlineStateCtrl.state,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: 'liquidGlass', systemColors: { secondaryLabel: '#888' } }),
}));
vi.mock('../../../theme/variants', () => ({
  selectByVariant: (_v: string, spec: { liquidGlass: unknown }) => spec.liquidGlass,
}));
vi.mock('../../../lib/onboarding/use-onboarding-copy', () => ({
  useOnboardingBoardCopy: () => ({
    title: 'Which board?',
    body: 'Every board keeps its own history.',
    offlineHint: 'Keep it on your phone.',
    findAnother: 'Find another board',
    findFirst: 'Find my board',
    offlineSkip: 'Skip for now',
    downloadLabelFor: (name: string) => `Keep ${name} on this phone`,
  }),
}));

import { OnboardingBoardStep, type OnboardingBoardStepProps } from '../OnboardingBoardStep';

function board(uuid: string, name: string): UserBoard {
  return {
    uuid,
    name,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '20,1',
  } as unknown as UserBoard;
}

const BOARDS = [board('board-1', 'Klimmuur'), board('board-2', 'Sterk')];

function renderStep(overrides: Partial<OnboardingBoardStepProps> = {}) {
  const props: OnboardingBoardStepProps = {
    accentColor: '#6D28D9',
    bodyColor: '#888888',
    backgroundColor: '#ffffff',
    boards: BOARDS,
    isLoading: false,
    offlineDownloadsEnabled: true,
    currentUserId: 'user-a',
    onSkipUnusable: null,
    onSelect: vi.fn(),
    onDownload: vi.fn(),
    onFindBoard: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<OnboardingBoardStep {...props} />) };
}

function buttonTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')].map((node) => node.textContent ?? '');
}

describe('OnboardingBoardStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backHandlerCtrl.handler = null;
    backHandlerCtrl.removed = false;
    offlineStateCtrl.state = 'off';
    carouselCtrl.items = [];
    carouselCtrl.onSelect = null;
    carouselCtrl.onDownload = null;
    cleanup();
  });

  it('renders the climber’s own boards in the shared carousel', () => {
    const { queryByTestId } = renderStep();

    expect(queryByTestId('carousel')).toBeTruthy();
    expect(carouselCtrl.items.map((item) => item.title)).toEqual(['Klimmuur', 'Sterk']);
  });

  // No board is pre-selected: the tick on a card means "this is your active
  // board", and during onboarding there isn't one yet.
  it('marks no card as active', () => {
    renderStep();
    expect(carouselCtrl.items.every((item) => !('isActive' in item && item.isActive))).toBe(true);
  });

  it('binds the tapped board', () => {
    const { props } = renderStep();

    carouselCtrl.onSelect?.({ key: 'board-2' });

    expect(props.onSelect).toHaveBeenCalledWith(BOARDS[1]);
  });

  // A refetch can drop a board between render and tap. Binding something else
  // would be worse than doing nothing.
  it('does nothing when the tapped board is no longer in the list', () => {
    const { props } = renderStep();

    carouselCtrl.onSelect?.({ key: 'vanished' });

    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('offers a per-card download, labelled with the board it would save', () => {
    const { props } = renderStep();

    expect(carouselCtrl.downloadLabelFor?.({ key: 'board-1', title: 'Klimmuur' })).toBe('Keep Klimmuur on this phone');
    carouselCtrl.onDownload?.({ key: 'board-1' });
    expect(props.onDownload).toHaveBeenCalledWith(BOARDS[0]);
  });

  it('hides the download glyph where the engine cannot run', () => {
    renderStep({ offlineDownloadsEnabled: false });
    expect(carouselCtrl.onDownload).toBeNull();
  });

  describe('with boards to choose from', () => {
    it('keeps the full picker as the quiet alternative', () => {
      const { container, props, getByText } = renderStep();

      expect(buttonTitles(container)).toEqual(['Find another board']);
      fireEvent.click(getByText('Find another board'));
      expect(props.onFindBoard).toHaveBeenCalled();
    });
  });

  // Issue #4961: "Failure there should fall through to the full /boards picker,
  // not a dead end." An empty list and a failed load look the same from here,
  // and both must offer the way forward rather than an empty slider.
  describe('with no boards', () => {
    it('leads with the full picker and shows no carousel', () => {
      const { container, queryByTestId } = renderStep({ boards: [] });

      expect(queryByTestId('carousel')).toBeNull();
      expect(buttonTitles(container)).toEqual(['Find my board']);
    });

    it('shows a spinner only while the list is still in flight', () => {
      const { queryByTestId } = renderStep({ boards: [], isLoading: true });
      expect(queryByTestId('spinner')).toBeTruthy();

      cleanup();
      const settled = renderStep({ boards: [], isLoading: false });
      expect(settled.queryByTestId('spinner')).toBeNull();
    });
  });

  describe('the escape hatch', () => {
    it('is absent unless the host says the screen cannot resolve', () => {
      const { container } = renderStep();
      expect(buttonTitles(container)).not.toContain('Skip for now');
    });

    it('appears — and only then — when there is nothing usable to show', () => {
      const onSkipUnusable = vi.fn();
      const { container, getByText } = renderStep({ boards: [], onSkipUnusable });

      expect(buttonTitles(container)).toEqual(['Find my board', 'Skip for now']);
      fireEvent.click(getByText('Skip for now'));
      expect(onSkipUnusable).toHaveBeenCalled();
    });
  });

  describe('Android hardware back', () => {
    it('is swallowed, so the step has no exit the UI does not show', () => {
      renderStep();
      expect(backHandlerCtrl.handler?.()).toBe(true);
    });

    it('releases the handler on unmount', () => {
      const { unmount } = renderStep();
      unmount();
      expect(backHandlerCtrl.removed).toBe(true);
    });
  });
});
