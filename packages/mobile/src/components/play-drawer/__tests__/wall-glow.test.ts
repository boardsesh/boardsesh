import { describe, expect, it } from 'vitest';
import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import {
  LABEL_FADE_STEPS,
  MAX_WALL_GLOW_BLOBS,
  MIN_LABEL_CONTRAST,
  blobGradient,
  wallGlowBlobs,
  wallGlowLabelContrast,
  wallGlowLabelFade,
  wallGlowPixel,
  type GlowHold,
  type WallGlowSurface,
} from '../wall-glow';

// The lit wall button's glow (#7000, F1b): the climb's holds, turned a quarter
// clockwise into the pill (start left, finish right, the board's left edge on
// top), with the label kept at 4.5:1.

const BOARD = { boardWidth: 100, boardHeight: 120 };
const PILL = { w: 360, h: 44 };
const DARK: WallGlowSurface = { base: '#0E0D12', label: '#FFFFFF', frost: true, border: 'rgba(255,255,255,0.2)' };
const LIGHT: WallGlowSurface = { base: '#F6F3FB', label: '#16111F', frost: false, border: 'rgba(0,0,0,0.12)' };

const hold = (x: number, y: number, color = '#4DF5FD'): GlowHold => ({ x, y, color });

describe('wallGlowBlobs', () => {
  it('reads the climb start to finish, left to right: the board turned a quarter clockwise', () => {
    const [start, finish] = wallGlowBlobs({
      ...BOARD,
      holds: [hold(50, 115, '#00DD00'), hold(50, 5, '#FF0000')],
      pill: PILL,
    });
    // The board's bottom (start) is the pill's left end, its top (finish) the right.
    expect(start?.x).toBeCloseTo(15);
    expect(finish?.x).toBeCloseTo(345);
    expect(start?.color).toBe('#00DD00');
    expect(finish?.color).toBe('#FF0000');
  });

  it("puts the board's left edge along the pill's top, its right edge along the bottom", () => {
    const [left, middle, right] = wallGlowBlobs({
      ...BOARD,
      holds: [hold(0, 60), hold(50, 60), hold(100, 60)],
      pill: PILL,
    });
    expect(left?.y).toBeCloseTo(0);
    expect(middle?.y).toBeCloseTo(22);
    expect(right?.y).toBeCloseTo(44);
    // A climb up the left of the board glows along the top.
    const leftLeaning = wallGlowBlobs({ ...BOARD, holds: [hold(10, 100), hold(15, 50), hold(20, 10)], pill: PILL });
    expect(leftLeaning.every((blob) => blob.y < PILL.h / 2)).toBe(true);
  });

  it('keeps the scale uniform where the board’s width fits the pill’s height, centred', () => {
    // A tall, narrow board: its 10-unit width at 360/600 is 6 pt, inside 44.
    const blobs = wallGlowBlobs({
      boardWidth: 10,
      boardHeight: 600,
      holds: [hold(0, 600), hold(10, 0)],
      pill: PILL,
    });
    expect(blobs[0]?.y).toBeCloseTo(19);
    expect(blobs[1]?.y).toBeCloseTo(25);
  });

  it('clamps a hold off the board to its edge', () => {
    const [blob] = wallGlowBlobs({ ...BOARD, holds: [hold(-20, 400)], pill: PILL });
    expect(blob).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps circles round, sized from the spacing and clamped 6..14 pt (plus the 2 x 16 pt blur)', () => {
    const crowded = wallGlowBlobs({
      ...BOARD,
      holds: [hold(50, 60), hold(50, 60.5), hold(50, 61)],
      pill: PILL,
    });
    expect(crowded[0]?.r).toBeCloseTo(6 + 32);
    const sparse = wallGlowBlobs({ ...BOARD, holds: [hold(0, 0), hold(100, 120)], pill: PILL });
    expect(sparse[0]?.r).toBeCloseTo(14 + 32);
    // One hold has no neighbour: the widest disc.
    expect(wallGlowBlobs({ ...BOARD, holds: [hold(50, 60)], pill: PILL })[0]?.r).toBeCloseTo(14 + 32);
  });

  it('draws nothing with no holds, no board or no pill yet: the flat amber', () => {
    expect(wallGlowBlobs({ ...BOARD, holds: [], pill: PILL })).toEqual([]);
    expect(wallGlowBlobs({ boardWidth: 0, boardHeight: 120, holds: [hold(1, 1)], pill: PILL })).toEqual([]);
    expect(wallGlowBlobs({ ...BOARD, holds: [hold(1, 1)], pill: { w: 0, h: 0 } })).toEqual([]);
  });

  it('keeps a long climb to a handful of Views, spread across the pill', () => {
    const holds = Array.from({ length: 40 }, (_, index) => hold(50, 120 - index * 3));
    const blobs = wallGlowBlobs({ ...BOARD, holds, pill: PILL });
    expect(blobs).toHaveLength(MAX_WALL_GLOW_BLOBS);
    expect(Math.min(...blobs.map((blob) => blob.x))).toBeCloseTo(0);
    expect(Math.max(...blobs.map((blob) => blob.x))).toBeCloseTo(351);
  });
});

describe('blobGradient', () => {
  it('fades the colour from its peak at the centre to nothing at the edge', () => {
    const gradient = blobGradient({ color: '#FF0000', peak: 0.5 });
    expect(gradient.startsWith('radial-gradient(circle closest-side, rgba(255, 0, 0, 0.5) 0%')).toBe(true);
    expect(gradient.endsWith('rgba(255, 0, 0, 0) 100%)')).toBe(true);
  });
});

describe('wallGlowLabelFade', () => {
  // The worst a climber can set: white holds, crowded under the label.
  const whiteCrowd = Array.from({ length: 9 }, (_, index) => hold(30 + index * 5, 40 + index * 5, '#FFFFFF'));
  const cases: [string, readonly GlowHold[], WallGlowSurface, 'screen' | 'multiply' | 'normal', number][] = [
    ['dark, white holds crowding the label', whiteCrowd, DARK, 'screen', 1],
    [
      'dark, MoonBoard colours',
      [hold(20, 100, '#44FF44'), hold(50, 60, '#4DF5FD'), hold(80, 10, '#FF3333')],
      DARK,
      'screen',
      1,
    ],
    ['dark, old Android (normal blending, lower strength)', whiteCrowd, DARK, 'normal', 0.6],
    [
      'light, dark-ish holds multiplying in',
      whiteCrowd.map((h) => ({ ...h, color: '#203040' })),
      LIGHT,
      'multiply',
      0.6,
    ],
    [
      'light, Kilter colours',
      [hold(20, 100, '#00DD00'), hold(50, 60, '#FF00FF'), hold(80, 10, '#FF0000')],
      LIGHT,
      'multiply',
      0.6,
    ],
  ];

  it.each(cases)('keeps the label at 4.5:1 or better: %s', (_case, holds, surface, blend, opacityScale) => {
    const blobs = wallGlowBlobs({ ...BOARD, holds, pill: PILL });
    const fade = wallGlowLabelFade(blobs, PILL, { surface, blend, opacityScale });
    expect([...LABEL_FADE_STEPS, 1]).toContain(fade);
    expect(wallGlowLabelContrast(blobs, PILL, { surface, blend, opacityScale, fade })).toBeGreaterThanOrEqual(
      MIN_LABEL_CONTRAST,
    );
  });

  it('fades nothing where the glow is already dark enough, and something where it is not', () => {
    const faint = wallGlowBlobs({ ...BOARD, holds: [hold(50, 118, '#202020')], pill: PILL });
    expect(wallGlowLabelFade(faint, PILL, { surface: DARK, blend: 'screen' })).toBe(0);
    const bright = wallGlowBlobs({ ...BOARD, holds: whiteCrowd, pill: PILL });
    expect(wallGlowLabelFade(bright, PILL, { surface: DARK, blend: 'screen' })).toBeGreaterThan(0);
  });

  it('preserves the player’s original centered fade choices exactly', () => {
    const fades = cases.map(([_case, holds, surface, blend, opacityScale]) => {
      const blobs = wallGlowBlobs({ ...BOARD, holds, pill: PILL });
      const options = { surface, blend, opacityScale };
      const fade = wallGlowLabelFade(blobs, PILL, options);
      expect(wallGlowLabelFade(blobs, PILL, { ...options, readableZone: 'center' })).toBe(fade);
      return fade;
    });
    expect(fades).toEqual([0.65, 0.65, 0.5, 0.2, 0]);
  });

  it.each([80, 210])('protects a cyan hold behind the lower-right header text at %d points wide', (width) => {
    const pill = { w: width, h: 38 };
    const textPoint = { x: width - 12, y: 28 };
    const blobs = wallGlowBlobs({
      ...BOARD,
      holds: [hold((textPoint.y / pill.h) * BOARD.boardWidth, (1 - textPoint.x / width) * BOARD.boardHeight)],
      pill,
    });
    const options = { surface: DARK, blend: 'screen' as const, opacityScale: 1 };
    const centeredFade = wallGlowLabelFade(blobs, pill, options);
    // The player's centre scrim spans 12%..88%, with a 10% feather at each end.
    // That drawing never protects the header's outer text as much as its centre.
    const scrimPosition = (textPoint.x / width - 0.12) / 0.76;
    const feather = Math.max(0, Math.min(1, scrimPosition / 0.1, (1 - scrimPosition) / 0.1));
    const oldPixel = wallGlowPixel(textPoint, blobs, { ...options, fade: centeredFade * feather });
    expect(contrastRatioHex(DARK.label, oldPixel)).toBeLessThan(MIN_LABEL_CONTRAST);

    const fullFade = wallGlowLabelFade(blobs, pill, { ...options, readableZone: 'full' });
    const fullPixel = wallGlowPixel(textPoint, blobs, { ...options, fade: fullFade });
    expect(contrastRatioHex(DARK.label, fullPixel)).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
  });

  it.each([
    ['dark', DARK, 'screen', 1, '#4DF5FD'],
    ['dark', DARK, 'screen', 1, '#FFFFFF'],
    ['light', LIGHT, 'multiply', 0.6, '#4DF5FD'],
    ['light', LIGHT, 'multiply', 0.6, '#203040'],
  ] as const)(
    'keeps both header lines and edges readable across the full %s pill with %s blending (%s, %s, %s)',
    (_scheme, surface, blend, opacityScale, color) => {
      for (const width of [80, 210]) {
        const pill = { w: width, h: 38 };
        const labelPoints = [
          { x: 12, y: 10 },
          { x: width - 12, y: 10 },
          { x: 12, y: 28 },
          { x: width - 12, y: 28 },
          { x: width / 2, y: 0 },
          { x: width / 2, y: pill.h },
        ];
        for (const textPoint of labelPoints) {
          const blobs = wallGlowBlobs({
            ...BOARD,
            holds: [
              hold((textPoint.y / pill.h) * BOARD.boardWidth, (1 - textPoint.x / width) * BOARD.boardHeight, color),
            ],
            pill,
          });
          const options = { surface, blend, opacityScale, readableZone: 'full' as const };
          const fade = wallGlowLabelFade(blobs, pill, options);
          let worstContrast = Infinity;
          // Check actual composited pixels more densely than the production
          // sampling, including the top, bottom and both edges of the scrim.
          for (let x = 0; x <= width; x += 1) {
            for (let y = 0; y <= pill.h; y += 1) {
              const pixel = wallGlowPixel({ x, y }, blobs, { ...options, fade });
              worstContrast = Math.min(worstContrast, contrastRatioHex(surface.label, pixel));
            }
          }
          expect(worstContrast, `${width}pt ${color} at ${textPoint.x},${textPoint.y}`).toBeGreaterThanOrEqual(
            MIN_LABEL_CONTRAST,
          );
        }
      }
    },
  );
});
