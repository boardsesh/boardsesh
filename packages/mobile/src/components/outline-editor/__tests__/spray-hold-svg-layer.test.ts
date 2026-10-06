import { describe, expect, it, vi } from 'vitest';

// The layer's native imports can't load under node; the step maths needs none of them.
vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
  PlatformColor: (name: string) => name,
}));
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
}));
vi.mock('react-native-svg', () => ({ default: () => null, G: () => null, Path: () => null }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({}) }));

const { ZOOM_STROKE_STEPS, cornerMarkRadii, zoomStrokeStep } = await import('../SprayHoldSvgLayer');
const { CORNERS_CLOSE_TARGET_PT } = await import('../spray-hold-tools');
const { loupeMagnification } = await import('../spray-gesture-math');

describe('zoomStrokeStep', () => {
  it('reaches the editor’s full 8x zoom', () => {
    expect(ZOOM_STROKE_STEPS[ZOOM_STROKE_STEPS.length - 1]).toBe(8);
  });

  it.each([
    [0.5, 1],
    [1, 1],
    [1.49, 1],
    [1.5, 1.5],
    [2.9, 2],
    [4, 4],
    [5.9, 4],
    [6, 6],
    [7.99, 6],
    [8, 8],
    [12, 8],
  ])('snaps a %sx zoom to the %sx step', (scale, step) => {
    expect(zoomStrokeStep(scale)).toBe(step);
  });

  it('never lets a ring run more than 1.5x its intended weight between steps', () => {
    for (let index = 1; index < ZOOM_STROKE_STEPS.length; index += 1) {
      expect(ZOOM_STROKE_STEPS[index] / ZOOM_STROKE_STEPS[index - 1]).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('cornerMarkRadii', () => {
  // A 3000 px photo drawn 375 pt wide: 8 board px per point.
  const BOARD_WIDTH = 3000;
  const RENDER_WIDTH = 375;
  const BOARD_SCALE = BOARD_WIDTH / RENDER_WIDTH;

  it.each([2, 4])('sizes the loupe’s close target to the overlay’s close radius at %sx', (zoom) => {
    // PolygonTapOverlay closes within CORNERS_CLOSE_TARGET_PT * boardScale / zoom board px.
    const overlayCloseRadius = (CORNERS_CLOSE_TARGET_PT * BOARD_SCALE) / zoom;
    // The loupe's layer sizes geometry from the board's zoom, not its magnification.
    const loupe = cornerMarkRadii(BOARD_WIDTH, RENDER_WIDTH, zoomStrokeStep(zoom));
    expect(loupe.targetRadius).toBeCloseTo(overlayCloseRadius, 9);
    // Sized from the magnification instead, the target came out smaller than the real one.
    const byMagnification = cornerMarkRadii(BOARD_WIDTH, RENDER_WIDTH, zoomStrokeStep(loupeMagnification(zoom)));
    expect(byMagnification.targetRadius).toBeLessThan(overlayCloseRadius);
  });

  it('draws nothing before the board has a width', () => {
    expect(cornerMarkRadii(BOARD_WIDTH, 0, 1)).toEqual({ dotRadius: 0, targetRadius: 0 });
  });
});
