// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode };

// PixelRatio.get() is the display density the overlay is rasterized against; pin
// it so the render-width assertions are about the component, not the host.
const pixelRatio = vi.hoisted(() => ({ value: 2 }));

vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  PixelRatio: { get: () => pixelRatio.value },
}));

// Capture what the kiosk hands the board renderer. The real BoardImageNative pulls
// in the Rust render pipeline and the bundled-asset cache — neither is under test
// here; the render sizing it is asked for is.
const boardImageProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.calls.push(props);
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000' } }),
}));

import { WallHeroStage } from '../WallHeroStage';

const boardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
} as unknown as Parameters<typeof WallHeroStage>[0]['boardConfig'];

function renderStage(artWidth: number): Record<string, unknown> {
  boardImageProps.calls.length = 0;
  render(
    createElement(WallHeroStage, {
      climb: null,
      boardConfig,
      boardWidth: 1080,
      boardHeight: 1170,
      artWidth,
      artHeight: artWidth,
    }),
  );
  const captured = boardImageProps.calls.at(-1);
  if (!captured) throw new Error('BoardImageNative did not render');
  return captured;
}

describe('WallHeroStage board-art sizing', () => {
  beforeEach(() => {
    pixelRatio.value = 2;
  });

  it('keeps the board photo full-resolution', () => {
    // Passing renderWidth flips useNativeClimbRender's background default to the
    // 416px `thumb` variant. The photo is one shared decode across every climb on
    // the wall, and this is the largest surface in the app — it must stay `full`.
    expect(renderStage(600).backgroundVariant).toBe('full');
  });

  it('sizes the holds overlay to the drawn surface rather than the board default', () => {
    // Omitting renderWidth rasterizes at the board's native width for every climb.
    // The assertion is the behavioural property — the request tracks the surface —
    // not a re-computation of the component's own arithmetic.
    const narrow = renderStage(400).renderWidth;
    const wide = renderStage(800).renderWidth;
    expect(typeof narrow).toBe('number');
    expect(wide as number).toBeGreaterThan(narrow as number);
  });

  it('scales the request by display density', () => {
    const atOneX = renderStage(500).renderWidth;
    pixelRatio.value = 3;
    const atThreeX = renderStage(500).renderWidth;
    expect(atThreeX as number).toBeGreaterThan(atOneX as number);
  });

  it('falls back to the native-width render before the surface is measured', () => {
    // A zero width would ask the Rust renderer for a 0px output. Undefined means
    // "native width" — the pre-existing behaviour — so an unmeasured frame renders
    // the board instead of nothing.
    expect(renderStage(0).renderWidth).toBeUndefined();
  });
});
