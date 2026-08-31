// @vitest-environment jsdom
//
// The regression this file exists for: the render path only probes the native
// library when the climber's OWN mode already asks for the Boardsesh drawing.
// This carousel previews the mode they are not on, so a climber sitting on
// Classic would never probe, the capability answer would stay `null`, and every
// Boardsesh card would render a skeleton forever — leaving only the Classic
// preview drawing anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ensureProbedMock = vi.hoisted(() => vi.fn());
const cardProps = vi.hoisted(() => ({ rendered: [] as { id: string; showSkeleton: boolean }[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  // Something in the import graph reads Platform at module scope.
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ data, renderItem }: { data: unknown[]; renderItem: (arg: { item: unknown }) => ReactNode }) =>
    createElement('div', null, ...data.map((item) => renderItem({ item }))),
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({ ensureBoardseshSupportProbed: ensureProbedMock }));
vi.mock('../../../lib/board-render-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/board-render-settings')>();
  return {
    ...actual,
    useBoardRenderSettings: () => ({ settings: actual.DEFAULT_BOARD_RENDER_SETTINGS, loaded: true }),
  };
});
vi.mock('../BoardLookPreviewCard', () => ({
  BOARD_LOOK_CARD_WIDTH: 168,
  BoardLookPreviewCard: (props: { option: { id: string }; showSkeleton: boolean }) => {
    cardProps.rendered.push({ id: props.option.id, showSkeleton: props.showSkeleton });
    return createElement('div', { 'data-testid': `card-${props.option.id}` });
  },
}));

const { BoardLookCarousel } = await import('../BoardLookCarousel');
const { BOARD_LOOK_ONBOARDING_OPTIONS } = await import('../../../lib/board-render/board-look-options');

const PREVIEW = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};

function renderCarousel(boardseshRendererAvailable: boolean | null) {
  return render(
    <BoardLookCarousel
      options={BOARD_LOOK_ONBOARDING_OPTIONS}
      selectedId="boardsesh"
      onSelect={vi.fn()}
      preview={PREVIEW}
      boardseshRendererAvailable={boardseshRendererAvailable}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cardProps.rendered = [];
});

afterEach(() => {
  cleanup();
});

describe('BoardLookCarousel', () => {
  it('forces the capability probe, whatever mode the climber is on', () => {
    // Without this the answer stays `null` for a climber on Classic and every
    // Boardsesh card skeletons for good.
    renderCarousel(null);

    expect(ensureProbedMock).toHaveBeenCalled();
  });

  it('skeletons the Boardsesh cards only while the answer is unknown', () => {
    renderCarousel(null);

    const skeletoned = cardProps.rendered.filter((card) => card.showSkeleton).map((card) => card.id);
    // Classic draws either way — it needs no Boardsesh renderer.
    expect(skeletoned).not.toContain('classic');
    expect(skeletoned).toContain('boardsesh');
  });

  it('draws every card once the probe says yes', () => {
    renderCarousel(true);

    expect(cardProps.rendered.every((card) => !card.showSkeleton)).toBe(true);
  });
});
