import { describe, expect, it } from 'vitest';
import { ACCESSORY_MIN_NAME_WIDTH, accessoryFitsBothControls } from '../accessory-control-slots';

// 16pt leading inset + 32pt artwork + 8pt gap + 4pt label padding + two 44pt slots + 8pt trailing inset.
const WIDTH_BESIDE_NAME = 156;

describe('accessoryFitsBothControls', () => {
  it('shows both controls before the first layout', () => {
    expect(accessoryFitsBothControls(null, WIDTH_BESIDE_NAME)).toBe(true);
  });

  it('shows both controls in an iPhone 17 Pro platter (~370pt)', () => {
    expect(accessoryFitsBothControls(370, WIDTH_BESIDE_NAME)).toBe(true);
  });

  it('shows both controls in a 375pt-wide iPhone platter (~343pt)', () => {
    expect(accessoryFitsBothControls(343, WIDTH_BESIDE_NAME)).toBe(true);
  });

  it("keeps one control in iPhone Duo's closed platter (290pt)", () => {
    // Measured from the closed-display shots: the platter beside the side rail.
    expect(accessoryFitsBothControls(290, WIDTH_BESIDE_NAME)).toBe(false);
  });

  it('keeps one control on a 320pt Display Zoom iPhone (~288pt platter), the same narrow-platter case', () => {
    // INFERRED: a 320pt-wide window (SE or 13 mini under Display Zoom) less the
    // platter's side margins. Not a Duo rule: any platter this narrow drops one.
    expect(accessoryFitsBothControls(288, WIDTH_BESIDE_NAME)).toBe(false);
  });

  it('switches exactly at the name floor', () => {
    expect(accessoryFitsBothControls(WIDTH_BESIDE_NAME + ACCESSORY_MIN_NAME_WIDTH, WIDTH_BESIDE_NAME)).toBe(true);
    expect(accessoryFitsBothControls(WIDTH_BESIDE_NAME + ACCESSORY_MIN_NAME_WIDTH - 1, WIDTH_BESIDE_NAME)).toBe(false);
  });

  it('gives the name the artwork room when the row has no artwork', () => {
    // No board config: no thumbnail, 40pt less beside the name, so the Duo's
    // 290pt platter fits both controls again.
    expect(accessoryFitsBothControls(290, WIDTH_BESIDE_NAME - 40)).toBe(true);
    expect(accessoryFitsBothControls(270, WIDTH_BESIDE_NAME - 40)).toBe(false);
  });
});
