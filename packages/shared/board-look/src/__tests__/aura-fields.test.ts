import { describe, expect, it } from 'vitest';
import { buildAuraRenderFields } from '../aura-fields';
import {
  AURA_BOARD_REACH_SCALE,
  BOARD_FIELD_COLORS,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  auraBoardReachScale,
  resolveVeilOpacity,
} from '../settings';

// A wall bright enough to take the strong veil bucket against the dark field
// (gap 0.541 - 0.200 = 0.341, over `veilStrongGap`), with enough of the board
// carrying an art reading to be allowed it. Tension Original's real numbers.
const brightWall = { mean: 0.541, coverage: 0.9 };

const baseInput = {
  settings: DEFAULT_BOARDSESH_RENDER_SETTINGS,
  boardName: 'kilter',
  glowFalloff: 'soft' as const,
  fieldColor: BOARD_FIELD_COLORS.dark,
  veilOpacity: 0,
  thumbnail: false,
  hasLedOffsets: false,
};

describe('buildAuraRenderFields', () => {
  it('draws the shipped look, field for field', () => {
    // A frozen literal, not a computed expectation: these numbers ARE the
    // drawing. Every renderer sends them, and a cached render lives a year
    // behind an immutable header, so a change here has to be a change somebody
    // meant to make.
    expect(buildAuraRenderFields(baseInput)).toEqual({
      render_mode: 'aura',
      mark_style: 'glow',
      glow_falloff: 'soft',
      glow: {
        reach_scale: 1,
        plateau_share: 0.4,
        disc_opacity: 0,
        small_hold_max_boost: 1.7,
        spread_fraction: 0.91,
        merge_softness: 0.6,
        seam_blend_fraction: 0.9,
        seam_sharpness: 3,
        fringe_deepen: 0.4,
      },
      fill: { opacity: 0.55 },
      glyphs: 'off',
    });
  });

  it("collapses the 'default' falloff itself rather than trusting the caller to", () => {
    // `'default'` is a setting value, not something the Rust renderer
    // understands. Resolving it here means a caller that forgets cannot hand the
    // string through to the renderer — there would be no type error to catch it.
    expect(buildAuraRenderFields({ ...baseInput, glowFalloff: 'default' }).glow_falloff).toBe('soft');
    expect(buildAuraRenderFields({ ...baseInput, glowFalloff: 'plateau' }).glow_falloff).toBe('plateau');
  });

  it('drops the glow bundle on a thumbnail and puts the fill under the mark', () => {
    const fields = buildAuraRenderFields({ ...baseInput, thumbnail: true });
    expect(fields.mark_style).toBe('glow-fill');
    expect(fields.glow).toEqual({
      reach_scale: 1,
      plateau_share: 0.4,
      disc_opacity: 0,
      small_hold_max_boost: 1.7,
    });
  });

  it('keeps the bare glow on a thumbnail when the climber asked for it', () => {
    const settings = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, thumbnailStyle: 'glow' as const };
    expect(buildAuraRenderFields({ ...baseInput, settings, thumbnail: true }).mark_style).toBe('glow');
  });

  it('omits the veil at zero rather than sending opacity 0', () => {
    // A light-mode field is brighter than every board's wall, so there is
    // nothing to quiet — and `opacity: 0` would still cost a cache variant.
    expect(buildAuraRenderFields(baseInput).veil).toBeUndefined();
    expect(buildAuraRenderFields({ ...baseInput, veilOpacity: 0.6 }).veil).toEqual({
      color: BOARD_FIELD_COLORS.dark,
      opacity: 0.6,
    });
  });

  it('covers the painted LED pips only where the art paints them', () => {
    expect(buildAuraRenderFields(baseInput).led_cover).toBeUndefined();
    expect(buildAuraRenderFields({ ...baseInput, hasLedOffsets: true }).led_cover).toEqual({});

    const settings = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ledDots: false };
    expect(buildAuraRenderFields({ ...baseInput, settings, hasLedOffsets: true }).led_cover).toBeUndefined();
  });

  it('turns the soft disc and the small-hold boost into their renderer values', () => {
    const settings = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, softDisc: true, smallHoldBoost: false };
    const { glow } = buildAuraRenderFields({ ...baseInput, settings });
    expect(glow.disc_opacity).toBe(0.3);
    expect(glow.small_hold_max_boost).toBe(1);
  });
});

describe('the per-board reach correction', () => {
  it('reaches 20% further on Woods at the shipped defaults', () => {
    // A Woods placement radius is ~1.1-1.6% of its board's width where an
    // Aurora one is ~2.8%, and the reach is measured off that radius — so
    // identical tuning glows over barely half the share of the wall it covers
    // on every other board (issue #4971).
    expect(buildAuraRenderFields({ ...baseInput, boardName: 'woods' }).glow.reach_scale).toBe(1.2);
  });

  it('multiplies the Glow-reach slider the climber saved rather than replacing it', () => {
    // A Woods climber who asked for half again the reach still gets it: the
    // board correction composes with the saved setting, it does not pin it.
    const wide = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowReach: 1.5 };
    expect(buildAuraRenderFields({ ...baseInput, settings: wide, boardName: 'woods' }).glow.reach_scale).toBeCloseTo(
      1.8,
      10,
    );

    // And a climber who pulled the slider DOWN still gets a tighter glow than
    // the Woods default — the correction cannot invert the setting's direction.
    const tight = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowReach: 0.5 };
    const tightWoods = buildAuraRenderFields({ ...baseInput, settings: tight, boardName: 'woods' }).glow.reach_scale;
    expect(tightWoods).toBeCloseTo(0.6, 10);
    expect(tightWoods).toBeLessThan(1.2);
  });

  it('carries the correction onto a Woods thumbnail too, where the glow bundle drops out', () => {
    // The bundle is skipped at 200px, but the reach is not part of the bundle —
    // a Woods list thumbnail has the same small-glow problem the play view has.
    const fields = buildAuraRenderFields({ ...baseInput, boardName: 'woods', thumbnail: true });
    expect(fields.glow).toEqual({
      reach_scale: 1.2,
      plateau_share: 0.4,
      disc_opacity: 0,
      small_hold_max_boost: 1.7,
    });
  });

  it('leaves every other board on the shared reach', () => {
    // Woods is the only row in the table, and the ONLY board whose pixels this
    // change may touch. An unknown name draws the shared reach rather than
    // throwing, which is what keeps a caller passing a board the look has never
    // heard of rendering.
    const shippedBoards = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard'];
    for (const boardName of [...shippedBoards, 'a-board-that-does-not-exist']) {
      expect(auraBoardReachScale(boardName)).toBe(1);
      expect(buildAuraRenderFields({ ...baseInput, boardName }).glow.reach_scale).toBe(1);
      const wide = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowReach: 1.5 };
      expect(buildAuraRenderFields({ ...baseInput, settings: wide, boardName }).glow.reach_scale).toBe(1.5);
    }

    expect(Object.keys(AURA_BOARD_REACH_SCALE)).toEqual(['woods']);
  });

  it('changes nothing else about the Woods drawing', () => {
    // The reach is the whole change: the curve, the brightness, the veil, the
    // fill and the mark all stay exactly what every other board sends.
    const woods = buildAuraRenderFields({ ...baseInput, boardName: 'woods', veilOpacity: 0.3 });
    const kilter = buildAuraRenderFields({ ...baseInput, boardName: 'kilter', veilOpacity: 0.3 });
    expect({ ...woods, glow: null }).toEqual({ ...kilter, glow: null });
    expect(woods.glow).toEqual({ ...kilter.glow, reach_scale: 1.2 });
  });
});

describe('resolveVeilOpacity', () => {
  it('washes a bright wall against the dark field and nothing against the light one', () => {
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, brightWall, BOARD_FIELD_COLORS.dark)).toBe(0.6);
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, brightWall, BOARD_FIELD_COLORS.light)).toBe(0);
  });

  it('does not guess at an unmeasured wall', () => {
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, null, BOARD_FIELD_COLORS.dark)).toBe(0);
  });

  it('takes a fixed bucket over the measurement when the climber picked one', () => {
    const fixed = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, veil: 'soft' as const };
    expect(resolveVeilOpacity(fixed, brightWall, BOARD_FIELD_COLORS.dark)).toBe(0.3);

    const off = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, veil: 'off' as const };
    expect(resolveVeilOpacity(off, brightWall, BOARD_FIELD_COLORS.dark)).toBe(0);

    const custom = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, veil: 'custom' as const, veilOpacity: 0.42 };
    expect(resolveVeilOpacity(custom, brightWall, BOARD_FIELD_COLORS.dark)).toBe(0.42);
  });
});
