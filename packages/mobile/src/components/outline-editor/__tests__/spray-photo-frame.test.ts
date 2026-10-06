import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
import { fitSprayPhoto } from '../spray-photo-frame';

describe('spray photo and two-row count controls', () => {
  it('reserves both control rows and the safe area below a tall photo', () => {
    const frame = fitSprayPhoto({
      areaWidth: 375,
      areaHeight: 700,
      bottomInset: 34,
      photoWidth: 500,
      photoHeight: 1000,
    });
    // Two 48pt rows, their 8pt gap, three 8pt gutters, and 34pt safe area.
    expect(frame.slotHeight).toBe(538);
    expect(frame.height).toBe(538);
    expect(frame.width).toBe(269);
  });
});
