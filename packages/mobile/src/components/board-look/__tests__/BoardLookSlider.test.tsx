// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
const control = vi.hoisted(() => ({
  imageProps: [] as {
    recyclingKey: string;
    renderSettingsOverride: { boardsesh: { roleGlyphs?: boolean } };
    underOverlay?: ReactNode;
  }[],
  selected: '',
  optionCount: 0,
  onChange: null as null | ((id: string) => void),
  probe: vi.fn(),
}));
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 400 }),
  PixelRatio: { get: () => 3 },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../hooks/use-reduce-transparency', () => ({ useReduceTransparency: () => false }));
vi.mock('../../../hooks/use-native-climb-render', () => ({ ensureBoardseshSupportProbed: control.probe }));
vi.mock('../../../lib/board-render-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/board-render-settings')>();
  return {
    ...actual,
    useBoardRenderSettings: () => ({
      settings: {
        ...actual.DEFAULT_BOARD_RENDER_SETTINGS,
        boardsesh: { ...actual.DEFAULT_BOARD_RENDER_SETTINGS.boardsesh, roleGlyphs: true },
      },
    }),
  };
});
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: (typeof control.imageProps)[number]) => {
    control.imageProps.push(props);
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));
vi.mock('../../LookOptionSlider', () => ({
  LookOptionSlider: (props: { value: string; options: unknown[]; onChange: (id: string) => void }) => {
    control.selected = props.value;
    control.optionCount = props.options.length;
    control.onChange = props.onChange;
    return createElement('div', { 'data-testid': 'option-slider' });
  },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../BoardPreviewSheet', () => ({ BoardPreviewSheet: () => null }));
const { BoardLookSlider } = await import('../BoardLookSlider');
const { BOARD_LOOK_ONBOARDING_OPTIONS } = await import('../../../lib/board-render/board-look-options');
const preview = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};
function draw(available: boolean | null, selectedId: 'aura' | 'classic' | 'custom' = 'aura') {
  return (
    <BoardLookSlider
      options={BOARD_LOOK_ONBOARDING_OPTIONS}
      selectedId={selectedId}
      onSelect={vi.fn()}
      preview={preview}
      boardseshRendererAvailable={available}
    />
  );
}
beforeEach(() => {
  control.imageProps = [];
  vi.clearAllMocks();
});
afterEach(cleanup);
describe('BoardLookSlider', () => {
  it('renders exactly one chosen preview and updates its settings on selection', () => {
    const { getAllByTestId, rerender } = render(draw(true));
    expect(getAllByTestId('board-image')).toHaveLength(1);
    expect(control.imageProps.at(-1)?.recyclingKey).toBe('aura');
    rerender(draw(true, 'classic'));
    expect(getAllByTestId('board-image')).toHaveLength(1);
    expect(control.imageProps.at(-1)?.recyclingKey).toBe('classic');
    expect(control.selected).toBe('classic');
  });
  it.each([null, false])('keeps unavailable choices but skeletons without misleading artwork: %s', (available) => {
    const { getByTestId, queryByTestId } = render(draw(available));
    expect(getByTestId('board-look-skeleton')).toBeTruthy();
    expect(queryByTestId('board-image')).toBeNull();
    expect(control.optionCount).toBe(7);
    expect(control.selected).toBe('aura');
    expect(control.probe).toHaveBeenCalledOnce();
  });
  it('Classic remains a true preview when the optional renderer is unavailable', () => {
    const { getByTestId, queryByTestId } = render(draw(false, 'classic'));
    expect(getByTestId('board-image')).toBeTruthy();
    expect(queryByTestId('board-look-skeleton')).toBeNull();
  });
  it('reports only real selected previews and preserves accessibility-owned render fields', () => {
    const seen = vi.fn();
    render(
      <BoardLookSlider
        options={BOARD_LOOK_ONBOARDING_OPTIONS}
        selectedId="aura"
        onSelect={vi.fn()}
        preview={preview}
        boardseshRendererAvailable
        onCardSeen={seen}
      />,
    );
    expect(seen).toHaveBeenCalledExactlyOnceWith('aura');
    expect(control.imageProps.at(-1)?.renderSettingsOverride.boardsesh.roleGlyphs).toBe(true);
  });
});
