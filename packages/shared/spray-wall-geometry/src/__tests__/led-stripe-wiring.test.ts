import { describe, expect, it } from 'vitest';
import { createLedStripes, isValidStripeWiring } from '../led-stripes';
import { createWiring, type CableDirection, type CableStartCorner } from '../led-layout';
import { DEFAULT_TNUT_CORNERS, generateTnutGrid, readTnutLayout, type TnutLayout } from '../tnut-layout';

function fixture(orientation: 'vertical' | 'horizontal'): TnutLayout {
  const basis: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 3,
    columns: 2,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    holes: [],
    photoKey: 'photo',
  };
  basis.holes = generateTnutGrid({ ...basis, pattern: 'grid' });
  const result = createLedStripes(basis, orientation, 4);
  if (result === 'capacity') throw new Error('Fixture exceeds capacity');
  return result;
}

describe('complete strip routing', () => {
  const cases = (['vertical', 'horizontal'] as const).flatMap((orientation) =>
    (['horizontal', 'vertical'] as CableDirection[]).flatMap((direction) =>
      (['tl', 'tr', 'bl', 'br'] as CableStartCorner[]).map((corner) => ({ orientation, direction, corner })),
    ),
  );

  it.each(cases)(
    'routes $orientation strips $direction from $corner as complete units',
    ({ orientation, direction, corner }) => {
      const layout = fixture(orientation);
      const leds = layout.ledPositions!;
      const wiring = createWiring(leds, direction, corner, layout);
      const path = wiring.paths.flat();
      expect(path).toHaveLength(leds.length);
      expect(new Set(path).size).toBe(leds.length);
      expect(isValidStripeWiring(layout.ledStripes!, wiring)).toBe(true);
      expect(readTnutLayout({ ...layout, wiring })).not.toBeNull();
      const first = leds.find((led) => led.id === path[0])!;
      if (orientation === 'vertical') expect(first.y).toBe(corner[0] === 'b' ? 1 : 0);
      else expect(first.x).toBe(corner[1] === 'r' ? 1 : 0);
    },
  );
});
