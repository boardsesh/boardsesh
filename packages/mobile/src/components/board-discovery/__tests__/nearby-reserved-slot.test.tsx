// @vitest-environment jsdom
//
// Near you sits right above Your boards, and its search answers a second or
// three after the picker opens, when most Your boards picks land. Placeholder
// cards hold the space while it searches, exactly as tall as a card, and the
// answer keeps at least that height, so Your boards never moves under a thumb.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';

type LayoutHandler = (event: { nativeEvent: { layout: { height: number } } }) => void;
const layoutCtrl = vi.hoisted(() => ({ onLayout: null as LayoutHandler | null }));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
    Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    View: ({
      children,
      style,
      testID,
      onLayout,
      accessibilityLabel,
      accessibilityElementsHidden,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      onLayout?: LayoutHandler;
      accessibilityLabel?: string;
      accessibilityElementsHidden?: boolean;
    }) => {
      if (onLayout) layoutCtrl.onLayout = onLayout;
      return createElement(
        'div',
        {
          'data-testid': testID,
          'data-style': JSON.stringify(flattenStyle(style)),
          'aria-label': accessibilityLabel,
          'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
        },
        children,
      );
    },
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      return typeof value === 'string' ? value : key;
    },
  }),
}));
vi.mock('../../Text', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Text: ({ children, variant, style }: { children?: ReactNode; variant?: string; style?: unknown }) =>
      createElement('span', { 'data-variant': variant, 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  };
});
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../AppMenu', () => ({ AppMenu: () => null }));
vi.mock('../use-board-card-menu-rows', () => ({ useBoardCardMenuRows: () => [] }));
vi.mock('../use-board-item-copy', () => ({ boardItemAccessibilityLabel: () => '', useBoardItemCopy: () => ({}) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { tertiaryBackground: '#TILE', separator: '#SEPARATOR' },
  }),
}));

import { textStylesByVariant, type TextVariant } from '../../../theme/typography';
import { layOutRendered } from '../../../../test/yoga-rendered-layout';
import { DISCOVERY_CARD_WIDTH } from '../BoardDiscoveryCardView';
import { NearbyReservedSlot } from '../NearbyReservedSlot';
import { PickerTouchContext } from '../picker-touch';

afterEach(() => {
  cleanup();
  layoutCtrl.onLayout = null;
});

function styleOf(element: Element | null): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

/** The picker's touch, as BoardSelectorView keeps it; null renders outside a picker. */
type Touch = { current: boolean } | null;

function slot(props: { searching: boolean; quiet: boolean }, touch: Touch = { current: true }) {
  const content = (
    <NearbyReservedSlot {...props}>
      <p>answer</p>
    </NearbyReservedSlot>
  );
  return touch === null ? content : <PickerTouchContext value={touch}>{content}</PickerTouchContext>;
}

/** Searches, draws 232pt of placeholders, then answers. */
function answer(quiet: boolean, touch: Touch) {
  const { rerender } = render(slot({ searching: true, quiet }, touch));
  reportPlaceholderHeight(232);
  rerender(slot({ searching: false, quiet }, touch));
  return styleOf(screen.getByTestId('near-you-slot'));
}

function reportPlaceholderHeight(height: number) {
  act(() => {
    layoutCtrl.onLayout?.({ nativeEvent: { layout: { height } } });
  });
}

describe('NearbyReservedSlot', () => {
  it('draws placeholder cards while the search runs, saying what is happening', () => {
    render(slot({ searching: true, quiet: true }));
    const row = screen.getByTestId('near-you-placeholder');
    expect(row.getAttribute('aria-label')).toBe('Looking for boards near you…');
    expect(row.children).toHaveLength(3);
    expect(screen.queryByText('answer')).toBeNull();
  });

  // A card: 168pt of art, 8pt, a two-line title box, one subtitle line.
  it('makes each placeholder exactly as tall as a Near you card', () => {
    render(slot({ searching: true, quiet: true }));
    const [placeholder] = Array.from(screen.getByTestId('near-you-placeholder').children);
    if (!placeholder) throw new Error('No placeholder card');
    const lineHeight = (variant: TextVariant) => textStylesByVariant.liquidGlass[variant].lineHeight;
    const layout = layOutRendered(placeholder, DISCOVERY_CARD_WIDTH, (element) => {
      if (element.tagName !== 'SPAN') return null;
      const lines = (element.textContent ?? '').split('\n').length;
      return { width: 0, height: lines * lineHeight(element.getAttribute('data-variant') as TextVariant) };
    });
    try {
      expect(layout.boxOf(placeholder).height).toBe(
        DISCOVERY_CARD_WIDTH + 8 + 2 * lineHeight('subheadline') + lineHeight('caption1'),
      );
    } finally {
      layout.free();
    }
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
  });

  // No finger on its way to a row yet: a quiet line ("No other boards within
  // 20 km", a search that failed, no fix) gives the space back.
  it("gives a quiet answer's space back while the picker is untouched", () => {
    expect(answer(true, { current: false })).toEqual({});
    expect(screen.getByText('answer')).toBeTruthy();
  });

  it('keeps the quiet line in the space the placeholders held, centred, once the picker was touched', () => {
    expect(answer(true, { current: true })).toEqual({ minHeight: 232, justifyContent: 'center' });
  });

  // A story or a test has no touch to read: nothing moves.
  it('keeps the space outside a picker', () => {
    expect(answer(true, null)).toEqual({ minHeight: 232, justifyContent: 'center' });
  });

  it.each([
    ['untouched', false],
    ['touched', true],
  ])('holds at least that height under the cards, from the top (%s)', (_name, touched) => {
    expect(answer(false, { current: touched })).toEqual({ minHeight: 232 });
  });

  // Decided when the answer lands: a touch after it changes nothing.
  it('keeps what it decided when the answer landed through later touches', () => {
    const touch = { current: false };
    const { rerender } = render(slot({ searching: true, quiet: true }, touch));
    reportPlaceholderHeight(232);
    rerender(slot({ searching: false, quiet: true }, touch));
    touch.current = true;
    rerender(slot({ searching: false, quiet: true }, touch));
    expect(styleOf(screen.getByTestId('near-you-slot'))).toEqual({});
    // A new search holds the space again, and decides again when it answers.
    rerender(slot({ searching: true, quiet: true }, touch));
    reportPlaceholderHeight(232);
    rerender(slot({ searching: false, quiet: true }, touch));
    expect(styleOf(screen.getByTestId('near-you-slot'))).toEqual({ minHeight: 232, justifyContent: 'center' });
  });

  // A cached answer: nothing was drawn before it, so there is nothing to hold.
  it('holds nothing when the search answered before any placeholder was drawn', () => {
    render(slot({ searching: false, quiet: true }));
    expect(styleOf(screen.getByTestId('near-you-slot'))).toEqual({});
  });
});
