// @vitest-environment jsdom
//
// The rail is a PICKER now, not the viewer it replaced, so the press has two
// meanings and only one of them writes. These cases pin which is which: a card
// you are not on gets applied, and the one you ARE on opens big instead of
// re-applying a palette you already have.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cardProps = vi.hoisted(() => ({
  enlarge: new Map<string, (id: string) => void>(),
  rendered: [] as { id: string; selected: boolean }[],
  press: new Map<string, (id: string) => void>(),
}));
const sheet = vi.hoisted(() => ({
  visible: false,
  title: null as string | null,
  holdColorOverride: undefined as Record<string, string> | undefined,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  // Something in the import graph reads Platform at module scope.
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => {} }),
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ data, renderItem }: { data: unknown[]; renderItem: (arg: { item: unknown }) => ReactNode }) =>
    createElement('div', null, ...data.map((item) => renderItem({ item }))),
}));
vi.mock('../PalettePreviewCard', () => ({
  PALETTE_CARD_WIDTH: 168,
  PalettePreviewCard: (props: {
    option: { id: string };
    selected: boolean;
    onPress: (id: string) => void;
    onEnlarge: (id: string) => void;
  }) => {
    cardProps.rendered.push({ id: props.option.id, selected: props.selected });
    cardProps.press.set(props.option.id, props.onPress);
    cardProps.enlarge.set(props.option.id, props.onEnlarge);
    return createElement('div', { 'data-testid': `card-${props.option.id}` });
  },
}));
vi.mock('../BoardPreviewSheet', () => ({
  BoardPreviewSheet: (props: {
    visible: boolean;
    title: string | null;
    holdColorOverride?: Record<string, string>;
  }) => {
    sheet.visible = props.visible;
    sheet.title = props.title;
    sheet.holdColorOverride = props.holdColorOverride;
    return createElement('div', null);
  },
}));

const { PaletteCarousel } = await import('../PaletteCarousel');

const PREVIEW = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};

function renderCarousel(selectedId: 'default' | 'deuteranopia' | 'custom', onSelect = vi.fn()) {
  render(<PaletteCarousel preview={PREVIEW} selectedId={selectedId} onSelect={onSelect} />);
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  cardProps.rendered = [];
  cardProps.press.clear();
  cardProps.enlarge.clear();
  sheet.visible = false;
  sheet.title = null;
  sheet.holdColorOverride = undefined;
});

afterEach(() => {
  cleanup();
});

describe('PaletteCarousel', () => {
  it('draws a card per palette and lights exactly the selected one', () => {
    renderCarousel('deuteranopia');

    expect(cardProps.rendered.map((card) => card.id)).toEqual([
      'default',
      'protanopia',
      'deuteranopia',
      'tritanopia',
      'custom',
    ]);
    expect(cardProps.rendered.filter((card) => card.selected).map((card) => card.id)).toEqual(['deuteranopia']);
  });

  it('applies a palette you are not on', () => {
    const onSelect = renderCarousel('default');

    act(() => cardProps.press.get('tritanopia')?.('tritanopia'));

    expect(onSelect).toHaveBeenCalledWith('tritanopia');
    expect(sheet.visible).toBe(false);
  });

  it('opens any palette big, including one you have not applied', () => {
    // A rail thumb is too small to judge two marker colours against each other,
    // which is the whole job here — and the palette you most need to check is
    // usually one you are NOT on. Enlarging used to be a second meaning for
    // pressing the card you had already applied, which put it out of reach on
    // every other card.
    const onSelect = renderCarousel('deuteranopia');

    act(() => cardProps.enlarge.get('tritanopia')?.('tritanopia'));

    expect(sheet.visible).toBe(true);
    expect(sheet.title).toBe('mobile.more.boardLook.accessibility.cvdPalette.presets.tritanopia');
    // Looking is not applying: nothing may reach the physical board's LEDs.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enlarges Default with no overrides, so the sheet shows the board’s own colours', () => {
    renderCarousel('default');

    act(() => cardProps.enlarge.get('default')?.('default'));

    expect(sheet.holdColorOverride).toEqual({});
  });
});
