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

  it('fits the photo to the whole area when the bottom is not reserved', () => {
    // An iPad in landscape under the header: a 4:3 photo is held by the height.
    const frame = fitSprayPhoto({
      areaWidth: 1180,
      areaHeight: 770,
      bottomInset: 20,
      photoWidth: 2048,
      photoHeight: 1536,
      reserveBottom: false,
    });
    expect(frame.slotHeight).toBe(770);
    expect(frame.height).toBe(770);
    expect(frame.width).toBeCloseTo(1026.67, 2);
  });

  it('is unchanged when the reserve is asked for explicitly', () => {
    const area = { areaWidth: 375, areaHeight: 700, bottomInset: 34, photoWidth: 500, photoHeight: 1000 };
    expect(fitSprayPhoto({ ...area, reserveBottom: true })).toEqual(fitSprayPhoto(area));
  });
});
