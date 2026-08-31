// @vitest-environment jsdom
//
// The card is the one thing the onboarding step and the Board look settings
// screen both draw, so its states have to be readable at a glance: which look is
// on, which cards cannot be drawn yet, and which one is the "build it yourself"
// plate. Everything asserted here is a state a climber has to be able to tell
// apart from the others without reading the label.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import type { BoardLookOption } from '../../../lib/board-render/board-look-options';

const BRAND_PRIMARY = '#6D28D9';
const SEPARATOR = '#C6C6C8';

const hapticLightMock = vi.hoisted(() => vi.fn());
const reduceMotion = vi.hoisted(() => ({ value: false }));
const reduceTransparency = vi.hoisted(() => ({ value: false }));

vi.mock('react-native', () => {
  /** Flattens the nested style arrays RN accepts into one object. */
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
  };
  const asDiv =
    (tag: string) =>
    ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
      createElement(
        tag,
        { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)) },
        children as ReactNode,
      );
  return {
    View: asDiv('div'),
    Pressable: ({
      children,
      style,
      onPress,
      testID,
    }: {
      children?: ReactNode;
      style?: unknown;
      onPress?: () => void;
      testID?: string;
    }) =>
      createElement(
        'button',
        { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)), onClick: onPress },
        children as ReactNode,
      ),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
    Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
    PlatformColor: (color: string) => color,
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: {
    createAnimatedComponent: <T,>(component: T) => component,
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children as ReactNode),
  },
  useAnimatedStyle: (build: () => unknown) => build(),
  useSharedValue: (initial: number) => ({ value: initial }),
  withSpring: (value: number) => value,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => reduceMotion.value }));
vi.mock('../../../hooks/use-reduce-transparency', () => ({ useReduceTransparency: () => reduceTransparency.value }));
// The card's press target. Forwards the accessibility contract so the picker
// semantics can be asserted, and the press handlers so a tap can be simulated.
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityState,
    accessibilityValue,
    feedback,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    accessibilityValue?: { text?: string };
    feedback?: string;
  }) =>
    createElement(
      'button',
      {
        'data-testid': 'card-press',
        'data-role': accessibilityRole,
        'data-checked': accessibilityState?.checked?.toString(),
        'data-value': accessibilityValue?.text,
        'data-feedback': feedback,
        onClick: onPress,
      },
      children as ReactNode,
    ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#888',
      separator: SEPARATOR,
      secondaryBackground: '#F2F2F7',
      tertiaryBackground: '#FFF',
      fill: '#78788033',
    },
    brandColors: { primary: BRAND_PRIMARY },
    textStyles: {
      title3: { fontSize: 20, lineHeight: 25 },
      subheadline: { fontSize: 15, lineHeight: 20 },
      caption1: { fontSize: 12, lineHeight: 16 },
    },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: hapticLightMock }));
vi.mock('../../Text', () => ({
  // Forwards `variant` and `numberOfLines`, so a test can assert which line of
  // the caption reserves the spare row height.
  Text: ({ children, variant, numberOfLines }: { children?: ReactNode; variant?: string; numberOfLines?: number }) =>
    createElement('span', { 'data-variant': variant, 'data-number-of-lines': numberOfLines?.toString() }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-testid': 'board-image' }),
}));

const { BoardLookPreviewCard } = await import('../BoardLookPreviewCard');

const PREVIEW = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};

const OPTION: BoardLookOption = {
  id: 'boardsesh',
  labelI18nKey: 'mobile.more.boardLook.presets.boardsesh',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.boardsesh',
  previewSettings: null,
  placeholderOverlay: false,
  requiresBoardseshRenderer: true,
};

const RAIL_LAYOUT = {
  size: 'rail' as const,
  thumbWidth: 134,
  thumbHeight: 168,
  renderWidth: 600,
  backgroundVariant: 'thumb' as const,
};

const HERO_LAYOUT = {
  size: 'hero' as const,
  thumbWidth: 289,
  thumbHeight: 361,
  renderWidth: 1024,
  backgroundVariant: 'full' as const,
};

function renderCard(overrides: Partial<ComponentProps<typeof BoardLookPreviewCard>> = {}) {
  return render(
    <BoardLookPreviewCard
      option={OPTION}
      preview={PREVIEW}
      layout={RAIL_LAYOUT}
      renderSettingsOverride={undefined}
      selected={false}
      index={0}
      total={5}
      showSkeleton={false}
      onPress={vi.fn()}
      onEnlarge={vi.fn()}
      {...overrides}
    />,
  );
}

function thumbStyle(container: HTMLElement): Record<string, unknown> {
  const thumb = container.querySelector('[data-testid="board-look-thumb"]');
  return JSON.parse(thumb?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  reduceMotion.value = false;
  reduceTransparency.value = false;
});

afterEach(() => {
  cleanup();
});

describe('BoardLookPreviewCard', () => {
  it('marks the look you are on with a badge and a brand frame', () => {
    const { container, queryByTestId } = renderCard({ selected: true });

    expect(queryByTestId('board-look-active-badge')).not.toBeNull();
    expect(thumbStyle(container)).toMatchObject({ borderWidth: 2, borderColor: BRAND_PRIMARY });
  });

  it('offers the full-size view on every card, not only the picked one', () => {
    // It used to appear on the selected card alone, which put it on exactly the
    // card you least need a closer look at: the one you already chose. The card
    // you want to inspect is usually one you have NOT picked yet.
    expect(renderCard({ selected: true }).queryByTestId('board-look-expand-badge')).not.toBeNull();
    cleanup();
    expect(renderCard({ selected: false }).queryByTestId('board-look-expand-badge')).not.toBeNull();
  });

  it('makes the full-size view a real, labelled control', () => {
    // It was an inert View: invisible to assistive tech and untappable.
    const onEnlarge = vi.fn();
    const { getByTestId } = renderCard({ selected: false, onEnlarge });

    const expand = getByTestId('board-look-expand-badge');
    expect(expand.getAttribute('data-testid')).toBe('board-look-expand-badge');
    expand.click();
    expect(onEnlarge).toHaveBeenCalledWith(OPTION.id);
  });

  it('announces itself as one option among several, not a lone button', () => {
    // `button` + selected says "selected" but conveys neither the exclusivity nor
    // the position — what a non-visual climber needs most on a step with no exit.
    const { getByTestId } = renderCard({ selected: true, index: 2, total: 5 });

    const press = getByTestId('card-press');
    expect(press.getAttribute('data-role')).toBe('radio');
    expect(press.getAttribute('data-checked')).toBe('true');
    expect(press.getAttribute('data-value')).toBe('mobile.more.boardLook.presets.position');
  });

  it('leaves an unpicked look unbadged and unframed', () => {
    const { container, queryByTestId } = renderCard({ selected: false });

    expect(queryByTestId('board-look-active-badge')).toBeNull();
    expect(thumbStyle(container)).toMatchObject({ borderColor: SEPARATOR });
  });

  it('drops the Active pill at hero size, where it would be a lie', () => {
    // In onboarding nothing is applied until the footer button is pressed, so
    // "Active" would overstate it — and the pill would sit on the holds the
    // climber is finally big enough to compare.
    const { queryByTestId } = renderCard({ selected: true, layout: HERO_LAYOUT });
    expect(queryByTestId('board-look-active-badge')).toBeNull();
  });

  it('takes the shape of the board rather than letterboxing it in a square', () => {
    // The bars used to cost up to 39% of the picture, and a square frame with
    // black margins reads as "thumbnail" rather than "your wall".
    const rail = thumbStyle(renderCard({ selected: false }).container);
    expect(rail.width).toBe(RAIL_LAYOUT.thumbWidth);
    expect(rail.height).toBe(RAIL_LAYOUT.thumbHeight);
    expect(rail.width).not.toBe(rail.height);
  });

  it('reserves the spare line for the description, not the name', () => {
    // The names here are single short words, so a two-line title box just
    // dropped every description a full line below its name — the gap in the
    // bug report. The descriptions are the sentences, so they get the
    // reservation that keeps the row's bottom edge level.
    const { container } = renderCard({ selected: false });
    const [title, description] = Array.from(container.querySelectorAll('[data-variant]')).filter((node) =>
      ['subheadline', 'caption1'].includes(node.getAttribute('data-variant') ?? ''),
    );

    expect(title?.getAttribute('data-number-of-lines')).toBe('1');
    expect(description?.getAttribute('data-number-of-lines')).toBe('2');
  });

  it('stops animating the press when Reduce Motion is on', () => {
    // 3% of a 306pt hero card is 9pt of unrequested movement on a screen nobody
    // can leave.
    reduceMotion.value = true;
    const { getByTestId } = renderCard({ layout: HERO_LAYOUT });
    expect(getByTestId('card-press').getAttribute('data-feedback')).toBe('none');
  });

  it('keeps the border the same width whether or not it is picked', () => {
    // Regression guard for 9e51e7394. Every card in this rail draws the SAME
    // climb and selection changes on every tap, so a border that grows on
    // selection resizes the image inside the thumb each time — which is what the
    // flicker report was. Only the colour may change.
    const picked = thumbStyle(renderCard({ selected: true }).container);
    const unpicked = thumbStyle(renderCard({ selected: false }).container);

    expect(picked.borderWidth).toBe(unpicked.borderWidth);
    expect(picked.borderColor).not.toBe(unpicked.borderColor);
  });

  it('mounts no board image while the renderer probe is unanswered', () => {
    // A Boardsesh card drawn then would resolve to a CLASSIC render, and the
    // climber would be choosing between labels over identical boards.
    const { queryByTestId } = renderCard({ showSkeleton: true });

    expect(queryByTestId('board-image')).toBeNull();
    expect(queryByTestId('board-look-skeleton')).not.toBeNull();
  });

  it('covers the thumb with the "?" plate on the Custom card', () => {
    const { queryByTestId } = renderCard({ option: { ...OPTION, id: 'custom', placeholderOverlay: true } });

    const placeholder = queryByTestId('board-look-placeholder');
    expect(placeholder).not.toBeNull();
    // Absolutely filling the THUMB, not the whole card — it has to pick up the
    // thumb's corner radius rather than square off over the caption.
    expect(placeholder?.parentElement?.getAttribute('data-testid')).toBe('board-look-thumb');
    // The plate hides a real render; it does not replace it.
    expect(queryByTestId('board-image')).not.toBeNull();
  });

  it('reports the option id, with a tap haptic', () => {
    const onPress = vi.fn();
    const { container } = renderCard({ onPress });

    container.querySelector('button')?.click();

    expect(onPress).toHaveBeenCalledWith('boardsesh');
    expect(hapticLightMock).toHaveBeenCalled();
  });
});
