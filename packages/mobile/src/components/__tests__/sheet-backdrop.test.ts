import { describe, it, expect, vi } from 'vitest';

// SheetBackdrop.tsx imports the full native chain (react-native, gesture-handler,
// reanimated, gorhom) at module load. This test only exercises the pure
// `isBackdropInteractive` gate + the `CLOSE_INDEX_EPSILON` constant, so stub those
// modules out so importing the file doesn't drag in any native code.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Tap: () => ({ onEnd: () => ({}) }) },
  GestureDetector: () => null,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: () => 0,
  runOnJS: (fn: unknown) => fn,
  useAnimatedReaction: () => undefined,
  useAnimatedStyle: () => ({}),
}));
vi.mock('@gorhom/bottom-sheet', () => ({
  useBottomSheet: () => ({ snapToIndex: () => undefined, close: () => undefined }),
}));

// Import after the mocks so module-load side effects resolve against the stubs.
import { isBackdropInteractive, CLOSE_INDEX_EPSILON } from '../SheetBackdrop';

describe('isBackdropInteractive', () => {
  const DISAPPEARS_AT_CLOSED = -1;

  it('is interactive when the sheet is open at index 0', () => {
    expect(isBackdropInteractive(0, DISAPPEARS_AT_CLOSED)).toBe(true);
  });

  it('is NOT interactive when fully closed at exactly -1', () => {
    expect(isBackdropInteractive(-1, DISAPPEARS_AT_CLOSED)).toBe(false);
  });

  it('is NOT interactive for a closed-but-drifted index of -0.9997 (the bug case)', () => {
    // gorhom's stock backdrop gates on the exact `animatedIndex <= disappearsOnIndex`,
    // i.e. `-0.9997 <= -1`, which is FALSE — so gorhom leaves the closed scrim
    // touchable and the whole app goes dead to touches. Our tolerant gate must
    // treat this effectively-closed sheet as inert.
    expect(isBackdropInteractive(-0.9997, DISAPPEARS_AT_CLOSED)).toBe(false);
  });

  it('is NOT interactive for a tiny drift just below the closed target (-0.999999)', () => {
    expect(isBackdropInteractive(-0.999999, DISAPPEARS_AT_CLOSED)).toBe(false);
  });

  it('is interactive when mid-open at -0.5 (scrim partially visible)', () => {
    expect(isBackdropInteractive(-0.5, DISAPPEARS_AT_CLOSED)).toBe(true);
  });

  it('honours a different disappearsOnIndex of 0', () => {
    const disappearsAtZero = 0;
    expect(isBackdropInteractive(0, disappearsAtZero)).toBe(false);
    expect(isBackdropInteractive(0.5, disappearsAtZero)).toBe(true);
    expect(isBackdropInteractive(1, disappearsAtZero)).toBe(true);
  });
});

describe('CLOSE_INDEX_EPSILON', () => {
  it('is comfortably larger than sub-pixel index drift yet far below the next snap point', () => {
    expect(CLOSE_INDEX_EPSILON).toBeGreaterThan(0.001);
    expect(CLOSE_INDEX_EPSILON).toBeLessThan(0.5);
  });
});
