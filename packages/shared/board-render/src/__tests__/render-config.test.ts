import { describe, expect, it } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { getBoardDetailsForBoard } from '../board-details';
import { buildRenderConfig, THUMBNAIL_WIDTH } from '../render-config';
import type { RenderableBoardDetails } from '../types';

const kilterDetails = getBoardDetailsForBoard({
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
});

const baseParams = {
  boardName: 'kilter',
  boardDetails: kilterDetails,
  frames: 'p1080r15',
  boardStates: HOLD_STATE_MAP.kilter,
};

describe('buildRenderConfig', () => {
  it('renders the OG variant with the thumbnail stroke treatment at OG scale', () => {
    const { config, ogScale } = buildRenderConfig({ ...baseParams, thumbnail: false, isOgVariant: true });
    expect(config.thumbnail).toBe(true);
    // Kilter 12x12 (1080x1170 board units) fitted into the padded 1200x630
    // canvas: height-limited to scale (630-96)/1170, so 1080 * 0.4564… = 493.
    expect(ogScale).toBeCloseTo(0.4564, 4);
    expect(config.output_width).toBe(493);
  });

  it('renders plain thumbnails at THUMBNAIL_WIDTH', () => {
    const { config } = buildRenderConfig({ ...baseParams, thumbnail: true, isOgVariant: false });
    expect(config.thumbnail).toBe(true);
    expect(config.output_width).toBe(THUMBNAIL_WIDTH);
  });

  it('renders native requests without the thumbnail treatment at native width', () => {
    const { config, ogScale } = buildRenderConfig({ ...baseParams, thumbnail: false, isOgVariant: false });
    expect(config.thumbnail).toBe(false);
    expect(config.output_width).toBe(kilterDetails.boardWidth);
    expect(ogScale).toBeNull();
  });

  it('classic mode never carries a render_mode, veil, glyphs, mark_style, led_cover, or per-hold/role fields', () => {
    // Byte-identical to today's classic output: none of the boardsesh-mode
    // keys exist at all, even when boardsesh-only params are (incorrectly)
    // passed alongside a classic renderMode.
    const { config } = buildRenderConfig({
      ...baseParams,
      thumbnail: false,
      isOgVariant: false,
      glowFalloff: 'plateau',
      glyphs: true,
      veil: { color: '#181225', opacity: 0.6 },
      markStyle: 'fill',
    });
    expect(config.render_mode).toBeUndefined();
    expect(config.veil).toBeUndefined();
    expect(config.glyphs).toBeUndefined();
    expect(config.glow_falloff).toBeUndefined();
    expect(config.mark_style).toBeUndefined();
    expect(config.led_cover).toBeUndefined();
    for (const hold of config.holds) {
      expect(hold.outline).toBeUndefined();
      expect(hold.led).toBeUndefined();
      expect(hold.silhouette_lightness).toBeUndefined();
    }
    for (const stateInfo of Object.values(config.hold_state_map)) {
      expect(stateInfo.role).toBeUndefined();
    }
  });

  it('always emits shape_size_multiplier: 1, in classic mode too (closes the web/OG drift from mobile)', () => {
    const { config } = buildRenderConfig({ ...baseParams, thumbnail: false, isOgVariant: false });
    expect(config.shape_size_multiplier).toBe(1);
  });
});

describe('buildRenderConfig — boardsesh mode', () => {
  // Synthetic, not a real board: hold 100 and 200 mirror each other, 300 is
  // unmirrored. Only 100 is lit, so 200 exercises the mirrored-partner rule
  // and 300 exercises "present on the board but not lit".
  const syntheticBoardDetails: RenderableBoardDetails = {
    board_name: 'kilter',
    boardWidth: 1080,
    boardHeight: 1350,
    images_to_holds: {},
    holdsData: [
      { id: 100, mirroredHoldId: 200, cx: 10, cy: 20, r: 5 },
      { id: 200, mirroredHoldId: 100, cx: 90, cy: 20, r: 5 },
      { id: 300, mirroredHoldId: null, cx: 50, cy: 50, r: 5 },
    ],
  };

  const boardseshParams = {
    boardName: 'kilter',
    boardDetails: syntheticBoardDetails,
    // Role 15 is FOOT on Kilter (see HOLD_STATE_MAP.kilter).
    frames: 'p100r15',
    boardStates: HOLD_STATE_MAP.kilter,
    thumbnail: false,
    isOgVariant: false,
    renderMode: 'boardsesh' as const,
  };

  it('emits render_mode, glow_falloff (defaulted), and glyphs: off (defaulted)', () => {
    const { config } = buildRenderConfig(boardseshParams);
    expect(config.render_mode).toBe('boardsesh');
    expect(config.glow_falloff).toBe('soft');
    expect(config.glyphs).toBe('off');
  });

  it('threads an explicit glow_falloff through', () => {
    const { config } = buildRenderConfig({ ...boardseshParams, glowFalloff: 'plateau' });
    expect(config.glow_falloff).toBe('plateau');
  });

  it('maps glyphs: true to "role"', () => {
    const { config } = buildRenderConfig({ ...boardseshParams, glyphs: true });
    expect(config.glyphs).toBe('role');
  });

  it('emits veil and mark_style only when passed', () => {
    const withoutExtras = buildRenderConfig(boardseshParams).config;
    expect(withoutExtras.veil).toBeUndefined();
    expect(withoutExtras.mark_style).toBeUndefined();

    const withExtras = buildRenderConfig({
      ...boardseshParams,
      veil: { color: '#181225', opacity: 0.6 },
      markStyle: 'fill',
    }).config;
    expect(withExtras.veil).toEqual({ color: '#181225', opacity: 0.6 });
    expect(withExtras.mark_style).toBe('fill');
  });

  it('lower-cases HoldStateInfo.name onto role, only for STARTING/HAND/FINISH/FOOT', () => {
    const { config } = buildRenderConfig(boardseshParams);
    // Kilter set 1/20 codes: 12 STARTING, 13 HAND, 14 FINISH, 15 FOOT, 36 HAND
    // (Tycho color-mode, still a HAND state) — all get role; there is no
    // AUX/ANY/NOT/OFF code in HOLD_STATE_MAP.kilter to assert the negative on
    // directly, so this only asserts the positive mapping is exact.
    expect(config.hold_state_map[12].role).toBe('starting');
    expect(config.hold_state_map[13].role).toBe('hand');
    expect(config.hold_state_map[14].role).toBe('finish');
    expect(config.hold_state_map[15].role).toBe('foot');
  });

  it('attaches outline/silhouette_lightness only to lit holds, and led to every bright-LED placement', () => {
    const { config } = buildRenderConfig({
      ...boardseshParams,
      holdGeometry: {
        outlines: { 100: [-1, -1, 1, -1, 1, 1, -1, 1], 300: [-1, -1, 1, -1, 1, 1, -1, 1] },
        ledBright: { 100: [0, -0.6], 300: [0, -0.6] },
        silhouetteLightness: { 100: 0.4, 300: 0.4 },
      },
    });
    const holdsById = new Map(config.holds.map((hold) => [hold.id, hold]));

    expect(holdsById.get(100)?.outline).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(holdsById.get(100)?.led).toEqual([0, -0.6]);
    expect(holdsById.get(100)?.silhouette_lightness).toBe(0.4);

    // 300 is on the board and has geometry available, but is not lit in the
    // first frame — no outline or lightness (nothing to draw), but its LED
    // cover still goes on: the art's bright pip must not read as a mark.
    expect(holdsById.get(300)?.outline).toBeUndefined();
    expect(holdsById.get(300)?.led).toEqual([0, -0.6]);
    expect(holdsById.get(300)?.silhouette_lightness).toBeUndefined();
  });

  it("also attaches geometry to a lit hold's mirroredHoldId partner", () => {
    const { config } = buildRenderConfig({
      ...boardseshParams,
      holdGeometry: { outlines: { 200: [-1, -1, 1, -1, 1, 1, -1, 1] } },
    });
    const holdsById = new Map(config.holds.map((hold) => [hold.id, hold]));

    // 200 is not itself lit, but is 100's mirror partner.
    expect(holdsById.get(200)?.outline).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
  });

  it('renders boardsesh mode with no outlines when holdGeometry is not passed', () => {
    const { config } = buildRenderConfig(boardseshParams);
    expect(config.render_mode).toBe('boardsesh');
    for (const hold of config.holds) {
      expect(hold.outline).toBeUndefined();
      expect(hold.led).toBeUndefined();
      expect(hold.silhouette_lightness).toBeUndefined();
    }
  });

  it("attaches the LED base plate ring to a lit hold, but never without the silhouette it's traced inside", () => {
    const outline = [-1, -1, 1, -1, 1, 1, -1, 1];
    const plate = [-0.6, -0.6, 0.6, -0.6, 0.6, 0.6, -0.6, 0.6];
    const { config } = buildRenderConfig({
      ...boardseshParams,
      // 100 is lit and traced; 200 is lit as 100's mirror partner but has no
      // outline, which is the shape a half-finished annotation takes; 300 is
      // traced but unlit.
      holdGeometry: { outlines: { 100: outline, 300: outline }, ledInner: { 100: plate, 200: plate, 300: plate } },
    });
    const holdsById = new Map(config.holds.map((hold) => [hold.id, hold]));

    expect(holdsById.get(100)?.led_inner).toEqual(plate);
    expect(holdsById.get(200)?.led_inner).toBeUndefined();
    expect(holdsById.get(300)?.led_inner).toBeUndefined();
    // And a board nobody has annotated carries no ring anywhere, which is
    // every shard shipping today.
    for (const hold of buildRenderConfig({ ...boardseshParams, holdGeometry: { outlines: { 100: outline } } }).config
      .holds) {
      expect(hold.led_inner).toBeUndefined();
    }
  });

  it('emits led_cover: {} only when holdGeometry.ledBright has entries', () => {
    expect(buildRenderConfig(boardseshParams).config.led_cover).toBeUndefined();
    expect(buildRenderConfig({ ...boardseshParams, holdGeometry: { ledBright: {} } }).config.led_cover).toBeUndefined();
    expect(
      buildRenderConfig({ ...boardseshParams, holdGeometry: { ledBright: { 100: [0, -0.6] } } }).config.led_cover,
    ).toEqual({});
  });
});
