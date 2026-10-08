import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (color: string) => color,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
import { fitSprayPhoto, SPRAY_BAR_RESERVE } from '../spray-photo-frame';

describe('spray photo and the one-row bottom bar', () => {
  it('reserves the bar row and the safe area below a tall photo', () => {
    const frame = fitSprayPhoto({
      areaWidth: 375,
      areaHeight: 700,
      bottomInset: 34,
      photoWidth: 500,
      photoHeight: 1000,
    });
    // One 48pt row, an 8pt gutter under it and one above it, and 34pt safe area.
    expect(frame.slotHeight).toBe(602);
    expect(frame.height).toBe(602);
    expect(frame.width).toBe(301);
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

  it('keeps 64pt free for the one-row bar', () => {
    expect(SPRAY_BAR_RESERVE).toBe(64);
  });
});
