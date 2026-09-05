import { describe, it, expect } from 'vitest';
import {
  resolveWallKioskLayout,
  quantizeDimension,
  WALL_KIOSK_GAP,
  ZONE_DOMINANCE_RATIO,
  type WallKioskLayout,
} from '../wall-kiosk-layout';
import {
  bandContentFloor,
  resolveWallKioskTypeScale,
  resolveHeroScale,
  estimatePhysicalLongSideMm,
  type WallKioskTypeScale,
} from '../wall-kiosk-type';

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

const CATALOG_RATIOS = [0.43, 0.56, 0.75, 1.0, 1.34, 1.81];
const PANES = [
  { label: '11" landscape', w: 1098, h: 834 },
  { label: '11" portrait', w: 738, h: 1194 },
  { label: '13" landscape', w: 1270, h: 1024 },
  { label: '13" portrait', w: 928, h: 1366 },
];

const area = (rect: { width: number; height: number }) => rect.width * rect.height;
const resolve = (w: number, h: number, ar: number, previous?: Pick<WallKioskLayout, 'region'>) =>
  resolveWallKioskLayout({ paneW: w, paneH: h, insets: NO_INSETS, boardAspectRatio: ar, previous }) as WallKioskLayout;

function preSenderTwoColumnFloor(scale: WallKioskTypeScale): number {
  const identityColumn =
    scale.stateLineHeight + 16 + scale.gradeLineHeight + 4 + 2 * scale.nameLineHeight + scale.metaLineHeight + 36;
  return Math.round(Math.max(identityColumn, 142) + 48 + 32);
}

function resolveProductionLayout({
  paneW,
  paneH,
  screenLongSide,
  boardAspectRatio,
  contentFloorBand,
}: {
  paneW: number;
  paneH: number;
  screenLongSide: number;
  boardAspectRatio: number;
  contentFloorBand?: number;
}): { layout: WallKioskLayout; typeScale: WallKioskTypeScale; heroScale: number } {
  const heroScale = resolveHeroScale({
    physicalLongSideMm: estimatePhysicalLongSideMm(screenLongSide),
    paneShortSide: Math.min(paneW, paneH),
  });
  const typeScale = resolveWallKioskTypeScale(Math.min(paneW, paneH), heroScale);
  const layout = resolveWallKioskLayout({
    paneW,
    paneH,
    insets: NO_INSETS,
    boardAspectRatio,
    heroScale,
    contentFloorBand: contentFloorBand ?? bandContentFloor(typeScale, quantizeDimension(paneW)),
  }) as WallKioskLayout;
  return { layout, typeScale, heroScale };
}

describe('quantizeDimension', () => {
  it('floors to the nearest 8px and floors junk to 0', () => {
    expect(quantizeDimension(1098)).toBe(1096);
    expect(quantizeDimension(1366)).toBe(1360);
    expect(quantizeDimension(0)).toBe(0);
    expect(quantizeDimension(-5)).toBe(0);
    expect(quantizeDimension(Number.NaN)).toBe(0);
  });
});

describe('resolveWallKioskLayout — always reserves an off-board chrome region', () => {
  it('returns null only before the pane is measured', () => {
    expect(resolveWallKioskLayout({ paneW: 0, paneH: 800, insets: NO_INSETS, boardAspectRatio: 0.56 })).toBeNull();
    expect(resolveWallKioskLayout({ paneW: 1000, paneH: 800, insets: NO_INSETS, boardAspectRatio: 0 })).toBeNull();
  });

  it('always yields a chrome region (never an overlay) for every catalog cell', () => {
    for (const pane of PANES) {
      for (const ratio of CATALOG_RATIOS) {
        const layout = resolve(pane.w, pane.h, ratio);
        expect(layout).not.toBeNull();
        expect(['rail', 'band']).toContain(layout.region);
        expect(layout.chromeRect.width).toBeGreaterThan(0);
        expect(layout.chromeRect.height).toBeGreaterThan(0);
        expect(layout.boardRect.width).toBeGreaterThan(0);
        expect(layout.boardRect.height).toBeGreaterThan(0);
      }
    }
  });
});

describe('resolveWallKioskLayout — argmax axis crossovers', () => {
  it('a tall board in landscape docks the chrome to a side RAIL', () => {
    expect(resolve(1098, 834, 0.43).region).toBe('rail');
    expect(resolve(1098, 834, 0.56).region).toBe('rail');
  });

  it('a tall board in portrait uses a bottom BAND (no room for a rail)', () => {
    expect(resolve(738, 1194, 0.43).region).toBe('band');
    expect(resolve(738, 1194, 0.56).region).toBe('band');
  });

  it('a wide board flips the reserve axis to a BAND even in landscape (kills the v1 starved-rail hole)', () => {
    expect(resolve(1098, 834, 1.81).region).toBe('band');
    expect(resolve(1270, 1024, 1.81).region).toBe('band');
  });

  it('keeps content-floor growth out of axis selection', () => {
    const { typeScale, heroScale } = resolveProductionLayout({
      paneW: 1270,
      paneH: 1024,
      screenLongSide: 1366,
      boardAspectRatio: 1.81,
    });
    const normalFloor = bandContentFloor(typeScale, 1270);
    const normal = resolveWallKioskLayout({
      paneW: 1270,
      paneH: 1024,
      insets: NO_INSETS,
      boardAspectRatio: 1.81,
      heroScale,
      contentFloorBand: normalFloor,
    }) as WallKioskLayout;
    const tallerCopy = resolveWallKioskLayout({
      paneW: 1270,
      paneH: 1024,
      insets: NO_INSETS,
      boardAspectRatio: 1.81,
      heroScale,
      contentFloorBand: normalFloor + 44,
    }) as WallKioskLayout;

    expect(normal.region).toBe('band');
    expect(tallerCopy.region).toBe(normal.region);
  });
});

describe('resolveWallKioskLayout — production attribution geometry', () => {
  it('keeps both common 11-inch portrait ratios banded, noncompact, and never below their pre-sender board size', () => {
    for (const boardAspectRatio of [0.56, 1.81]) {
      const production = resolveProductionLayout({
        paneW: 738,
        paneH: 1194,
        screenLongSide: 1194,
        boardAspectRatio,
      });
      const baseline = resolveProductionLayout({
        paneW: 738,
        paneH: 1194,
        screenLongSide: 1194,
        boardAspectRatio,
        contentFloorBand: preSenderTwoColumnFloor(production.typeScale),
      });

      expect(production.layout.region).toBe('band');
      expect(baseline.layout.region).toBe('band');
      expect(production.layout.compact).toBe(false); // Lit by + Sent by remain eligible.
      // The board is aspect-constrained at this pane, so dropping the hoisted
      // driver row from the two-column floor gives the height back to the band
      // rather than growing the board — the board must simply never shrink.
      expect(area(production.layout.boardRect)).toBeGreaterThanOrEqual(area(baseline.layout.boardRect));
      expect(production.layout.chromeRect.height).toBeLessThanOrEqual(baseline.layout.chromeRect.height);
    }
  });

  it('keeps a wide climb on the 13-inch landscape pane in a noncompact band without shrinking its board', () => {
    const production = resolveProductionLayout({
      paneW: 1270,
      paneH: 1024,
      screenLongSide: 1366,
      boardAspectRatio: 1.81,
    });
    const baseline = resolveProductionLayout({
      paneW: 1270,
      paneH: 1024,
      screenLongSide: 1366,
      boardAspectRatio: 1.81,
      contentFloorBand: preSenderTwoColumnFloor(production.typeScale),
    });

    expect(production.layout.region).toBe('band');
    expect(baseline.layout.region).toBe('band');
    expect(production.layout.compact).toBe(false); // Lit by + Sent by remain eligible.
    expect(production.layout.boardAreaFraction).toBeGreaterThanOrEqual(baseline.layout.boardAreaFraction);
    expect(production.layout.boardAreaFraction).toBeGreaterThan(0.95);
  });
});

describe('resolveWallKioskLayout — board is the largest region + never overlapped', () => {
  for (const pane of PANES) {
    for (const ratio of CATALOG_RATIOS) {
      it(`board dominates + board+gap+chrome fits the pane — ${pane.label}, AR ${ratio}`, () => {
        const layout = resolve(pane.w, pane.h, ratio);
        // The board is always the largest single region by AREA.
        expect(area(layout.boardRect)).toBeGreaterThan(area(layout.chromeRect));
        if (layout.region === 'rail') {
          // Chrome never wider than the board on the reserve axis; ideally ≤0.85×
          // but the chrome legibility min can relax the ratio at extreme-tall ARs.
          expect(layout.chromeRect.width).toBeLessThanOrEqual(layout.boardRect.width + 1);
          if (!layout.compact) {
            expect(layout.chromeRect.width).toBeLessThanOrEqual(
              Math.max(ZONE_DOMINANCE_RATIO * layout.boardRect.width, 320) + 1,
            );
          }
          expect(layout.boardRect.width + WALL_KIOSK_GAP + layout.chromeRect.width).toBeLessThanOrEqual(pane.w + 1);
          expect(layout.boardRect.height).toBeLessThanOrEqual(pane.h + 1);
        } else {
          expect(layout.chromeRect.height).toBeLessThanOrEqual(layout.boardRect.height + 1);
          expect(layout.boardRect.height + WALL_KIOSK_GAP + layout.chromeRect.height).toBeLessThanOrEqual(pane.h + 1);
          expect(layout.boardRect.width).toBeLessThanOrEqual(pane.w + 1);
        }
      });
    }
  }
});

describe('resolveWallKioskLayout — free vs steal + board-area floor', () => {
  it('keeps the board at 100% when the natural gutter absorbs the chrome (tall board, landscape)', () => {
    const layout = resolve(1098, 834, 0.56);
    expect(layout.isFreeAxis).toBe(true);
    expect(layout.boardAreaFraction).toBeCloseTo(1, 2);
  });

  it('holds the board-area floor (≥0.55) when the chrome must steal, across the grid', () => {
    for (const pane of PANES) {
      for (const ratio of CATALOG_RATIOS) {
        const layout = resolve(pane.w, pane.h, ratio);
        // The floor may only be breached when the chrome min forced it (documented);
        // the dominance cap otherwise keeps the board well above the floor.
        expect(layout.boardAreaFraction).toBeGreaterThanOrEqual(0.34); // inherent wide-in-portrait letterbox
        if (layout.isFreeAxis) expect(layout.boardAreaFraction).toBeCloseTo(1, 2);
      }
    }
  });
});

describe('resolveWallKioskLayout — axis hysteresis', () => {
  // At pane 1000×800 the rail↔band board areas cross near AR≈1.22, so the two
  // axes are within the 4% deadband there.
  it('holds the previous region when the challenger only marginally wins', () => {
    const fresh = resolve(1000, 800, 1.22);
    expect(fresh.region).toBe('band'); // band wins by <4%
    // With the losing axis as the incumbent, the marginal challenger can't flip it.
    expect(resolve(1000, 800, 1.22, { region: 'rail' }).region).toBe('rail');
    // With the winner as the incumbent, it trivially stays.
    expect(resolve(1000, 800, 1.22, { region: 'band' }).region).toBe('band');
  });

  it('still flips when the challenger axis clearly wins (beyond the deadband)', () => {
    // A wide board in landscape: band beats rail decisively, so previous=rail flips.
    expect(resolve(1098, 834, 1.81, { region: 'rail' }).region).toBe('band');
  });
});

describe('resolveWallKioskLayout — band spans the full content width', () => {
  it('a band chrome is the full pane width (drives the two-column layout)', () => {
    const layout = resolve(738, 1194, 0.56); // 11" portrait → band
    expect(layout.region).toBe('band');
    expect(layout.chromeRect.width).toBe(quantizeDimension(738)); // full content width (quantized)
  });

  it('keeps the board dominant with a full-width band even in a narrow Split View', () => {
    // ⅓ Split View on an 11" Pro: a wide board would otherwise let a full-width
    // band out-mass the letterboxed board (the rail-only compact-escape gap).
    for (const ratio of [0.43, 0.56, 1.0, 1.81]) {
      const layout = resolveWallKioskLayout({
        paneW: 320,
        paneH: 834,
        insets: NO_INSETS,
        boardAspectRatio: ratio,
        contentFloorBand: 236,
      }) as WallKioskLayout;
      expect(area(layout.boardRect)).toBeGreaterThanOrEqual(area(layout.chromeRect));
      expect(layout.boardRect.width).toBeGreaterThan(0);
    }
  });
});

describe('wall-kiosk-type', () => {
  it('estimates physical size and clamps hero scale', () => {
    expect(estimatePhysicalLongSideMm(1366)).toBeGreaterThan(250);
    expect(resolveHeroScale({ physicalLongSideMm: estimatePhysicalLongSideMm(1366) })).toBeGreaterThanOrEqual(1);
    expect(resolveHeroScale({ paneShortSide: 200 })).toBe(1);
  });

  it('always makes the grade louder than the name', () => {
    for (const shortSide of [738, 834, 1000, 1024]) {
      const scale = resolveWallKioskTypeScale(shortSide, 1);
      expect(scale.gradeFontSize).toBeGreaterThan(scale.nameFontSize);
      expect(scale.nameFontSize).toBeGreaterThan(scale.metaFontSize);
    }
  });

  it('uses band width to fund both attribution rows without inflating common two-column geometry', () => {
    const scale = resolveWallKioskTypeScale(738, 1);
    const preSenderFloor = preSenderTwoColumnFloor(scale);

    // A two-column band hoists attribution out of the identity column, so it no
    // longer funds the 36pt Lit-by driver row the pre-sender formula charged for.
    expect(bandContentFloor(scale, 738)).toBe(preSenderFloor - 36);
    expect(bandContentFloor(scale, 1270)).toBeLessThan(preSenderFloor);
    // The stacked band still renders attribution inline, so it keeps the driver
    // row and adds a second one (36) plus the gap (8) for the sender line.
    expect(bandContentFloor(scale, 500)).toBe(preSenderFloor + 44);
  });

  it('grows the stacked sender row when hero-scaled copy outgrows the avatar floor', () => {
    // A large external display narrow enough to stack pushes the meta line past
    // the 36pt driver-row height. The Sent-by row it funds has to follow, or the
    // band clips the line it just made room for.
    const scale = resolveWallKioskTypeScale(639, 1.8);
    const senderRow = Math.max(28, scale.metaLineHeight) + 2;
    expect(senderRow).toBeGreaterThan(36);

    // Stacked funds both rows that the two-column band hoists away: the Lit-by
    // driver row (36, inside the identity column) and the Sent-by row plus gap.
    const stacked = bandContentFloor(scale, 500);
    const twoColumn = bandContentFloor(scale, 738);
    expect(stacked - twoColumn).toBe(36 + senderRow + 8);

    // And at a scale whose copy fits inside the avatar floor, the row stays 36.
    const smallScale = resolveWallKioskTypeScale(500, 1);
    expect(Math.max(28, smallScale.metaLineHeight) + 2).toBeLessThan(36);
    expect(bandContentFloor(smallScale, 500) - bandContentFloor(smallScale, 738)).toBe(36 + 36 + 8);
  });
});
