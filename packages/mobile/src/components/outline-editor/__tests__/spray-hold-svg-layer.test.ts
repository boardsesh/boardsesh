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

const { ZOOM_STROKE_STEPS, zoomStrokeStep } = await import('../SprayHoldSvgLayer');

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
