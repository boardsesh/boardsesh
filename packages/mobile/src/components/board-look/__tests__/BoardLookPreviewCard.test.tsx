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
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: <T,>(component: T) => component },
  useAnimatedStyle: (build: () => unknown) => build(),
  useSharedValue: (initial: number) => ({ value: initial }),
  withSpring: (value: number) => value,
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
    textStyles: { subheadline: { fontSize: 15, lineHeight: 20 } },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: hapticLightMock }));
vi.mock('../../../hooks/use-board-preview-climb', () => ({ BOARD_PREVIEW_RENDER_WIDTH: 600 }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
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

function renderCard(overrides: Partial<ComponentProps<typeof BoardLookPreviewCard>> = {}) {
  return render(
    <BoardLookPreviewCard
      option={OPTION}
      preview={PREVIEW}
      renderSettingsOverride={undefined}
      selected={false}
      showSkeleton={false}
      onPress={vi.fn()}
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

  it('leaves an unpicked look with neither', () => {
    const { container, queryByTestId } = renderCard({ selected: false });

    expect(queryByTestId('board-look-active-badge')).toBeNull();
    expect(thumbStyle(container)).toMatchObject({ borderColor: SEPARATOR });
  });

  it('keeps the border the same width whether or not it is picked', () => {
    // Regression guard for 9e51e7394. Every card in this rail draws the SAME
    // climb and selection changes on every tap, so a border that grows on
    // selection resizes the letterboxed image inside the thumb each time — which
    // is what the flicker report was. Only the colour may change.
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
