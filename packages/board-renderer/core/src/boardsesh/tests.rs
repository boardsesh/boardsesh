use std::collections::HashMap;

use super::*;
use crate::renderer::render_overlay;
use crate::types::{
    BoardRenderMode, GlowFalloff, GlowTuning, GlyphMode, GlyphTuning, HoldMarkerShape, HoldRole,
    HoldStateInfo, LedBaseTuning, LedCover, MarkStyle, Veil,
};

const SIZE: u32 = 400;
const SQUARE: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0];
/// The hold proper inside `SQUARE`: leaves a 10 px plate ring all the way round.
const SQUARE_INNER: [f32; 8] = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
/// 12 × 12 px blob on a 20 px radius: longest 12 < 18 → boost 1.5.
const TINY: [f32; 8] = [-0.3, -0.3, 0.3, -0.3, 0.3, 0.3, -0.3, 0.3];
/// 4 px wide sliver: shortest 4 → extent cap 7.2 px.
const SLIVER: [f32; 8] = [-0.1, -1.0, 0.1, -1.0, 0.1, 1.0, -0.1, 1.0];

fn state(color: &str, role: HoldRole) -> HoldStateInfo {
    HoldStateInfo {
        color: color.into(),
        render_style: Default::default(),
        shape: HoldMarkerShape::Circle,
        role,
    }
}

fn hold(id: u32, cx: f32, cy: f32, outline: Option<&[f32]>) -> HoldData {
    HoldData {
        id,
        mirrored_hold_id: None,
        cx,
        cy,
        r: 20.0,
        outline: outline.map(|points| points.to_vec()),
        led_inner: None,
        led: None,
        silhouette_lightness: None,
    }
}

/// A 400 × 400 board rendered 1:1. Hold 1 is a 40 px square at (100, 100),
/// hold 2 an outline-less circle at (300, 100), hold 3 the tiny blob at
/// (100, 300), hold 4 the sliver at (300, 300).
fn config(frames: &str) -> RenderConfig {
    let mut hold_state_map = HashMap::new();
    hold_state_map.insert(42, state("#00FF00", HoldRole::Starting));
    hold_state_map.insert(43, state("#00FFFF", HoldRole::Hand));
    hold_state_map.insert(44, state("#FF00FF", HoldRole::Finish));
    hold_state_map.insert(45, state("#FFAA00", HoldRole::Foot));
    RenderConfig {
        board_width: SIZE as f32,
        board_height: SIZE as f32,
        output_width: SIZE,
        frames: frames.into(),
        mirrored: false,
        thumbnail: false,
        stroke_width_multiplier: 1.0,
        shape_size_multiplier: 1.0,
        holds: vec![
            hold(1, 100.0, 100.0, Some(&SQUARE)),
            hold(2, 300.0, 100.0, None),
            hold(3, 100.0, 300.0, Some(&TINY)),
            hold(4, 300.0, 300.0, Some(&SLIVER)),
        ],
        hold_state_map,
        render_mode: BoardRenderMode::Boardsesh,
        veil: None,
        mark_style: None,
        glow_falloff: GlowFalloff::Soft,
        glow: GlowTuning::default(),
        fill: Default::default(),
        glyphs: GlyphMode::Off,
        glyph: GlyphTuning::default(),
        led_cover: None,
        led_base: LedBaseTuning::default(),
    }
}

fn pixel(data: &[u8], x: u32, y: u32) -> [u8; 4] {
    let offset = ((y * SIZE + x) * 4) as usize;
    [
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]
}

fn alpha(data: &[u8], x: u32, y: u32) -> u8 {
    pixel(data, x, y)[3]
}

fn total_alpha(data: &[u8]) -> u64 {
    data.chunks(4).map(|px| px[3] as u64).sum()
}

fn render(config: &RenderConfig) -> Vec<u8> {
    let (data, width, height) = render_overlay(config).unwrap();
    assert_eq!((width, height), (SIZE, SIZE));
    data
}

#[test]
fn classic_mode_is_the_default_and_unknown_modes_fall_back_to_it() {
    let mut classic = config("p1r42");
    classic.render_mode = BoardRenderMode::Classic;
    let classic_data = render(&classic);
    let mut unknown = config("p1r42");
    unknown.render_mode = BoardRenderMode::Unknown;
    assert_eq!(render(&unknown), classic_data);
    let boardsesh = render(&config("p1r42"));
    assert_ne!(boardsesh, classic_data);
    let parsed: RenderConfig = serde_json::from_str(
        r##"{"board_width":10,"board_height":10,"output_width":10,"frames":"","thumbnail":false,"holds":[],"hold_state_map":{},
             "render_mode":"hologram","glow_falloff":"cliff","mark_style":"sparkle","glyphs":"maybe"}"##,
    )
    .unwrap();
    assert_eq!(parsed.render_mode, BoardRenderMode::Unknown);
    assert_eq!(parsed.glow_falloff, GlowFalloff::Unknown);
    assert_eq!(parsed.mark_style, Some(MarkStyle::Unknown));
    assert_eq!(parsed.glyphs, GlyphMode::Unknown);
}

#[test]
fn full_boardsesh_json_parses_with_every_field() {
    let json = r##"{
      "board_width": 400, "board_height": 400, "output_width": 400, "frames": "p1r43", "thumbnail": false,
      "render_mode": "boardsesh",
      "veil": {"color": "#181225", "opacity": 0.6},
      "mark_style": "glow-fill",
      "glow_falloff": "plateau",
      "glow": {"spread_fraction": 0.7, "reach_scale": 1.5, "plateau_share": 0.5, "disc_opacity": 0.3},
      "fill": {"opacity": 0.7},
      "glyphs": "role",
      "glyph": {"line_width_fraction": 0.11},
      "led_cover": {},
      "led_base": {"opacity": 0.8},
      "holds": [{"id": 1, "cx": 100, "cy": 100, "r": 20, "outline": [-1,-1,1,-1,1,1,-1,1], "led_inner": [-0.5,-0.5,0.5,-0.5,0.5,0.5,-0.5,0.5], "led": [0.5, 0.0], "silhouette_lightness": 0.3},
                {"id": 2, "cx": 300, "cy": 100, "r": 20, "mirroredHoldId": 1}],
      "hold_state_map": {"43": {"color": "#00FFFF", "role": "hand"}, "44": {"color": "#FF00FF", "role": "FINISH"}}
    }"##;
    let parsed: RenderConfig = serde_json::from_str(json).unwrap();
    assert_eq!(parsed.render_mode, BoardRenderMode::Boardsesh);
    assert_eq!(parsed.veil.as_ref().unwrap().opacity, 0.6);
    assert_eq!(parsed.mark_style, Some(MarkStyle::GlowFill));
    assert_eq!(parsed.glow_falloff, GlowFalloff::Plateau);
    assert_eq!(parsed.glow.reach_scale, 1.5);
    assert_eq!(parsed.glow.hold_extent_cap, 1.8); // untouched default
    assert_eq!(parsed.fill.opacity, 0.7);
    assert_eq!(parsed.glyphs, GlyphMode::Role);
    assert_eq!(parsed.led_cover.as_ref().unwrap().radius_fraction, 0.1);
    assert_eq!(parsed.led_base.opacity, 0.8);
    assert_eq!(parsed.led_base.interior_fill_scale, 0.6); // untouched default
    assert!(parsed.led_base.glow_from_base);
    assert_eq!(parsed.holds[0].led, Some([0.5, 0.0]));
    assert_eq!(
        parsed.holds[0].led_inner.as_deref(),
        Some([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5].as_slice())
    );
    // A config from a JS bundle that predates the plate parses to the defaults
    // rather than failing, the way every Boardsesh field before it does.
    let older: RenderConfig = serde_json::from_str(
        r##"{"board_width":10,"board_height":10,"output_width":10,"frames":"","thumbnail":false,"holds":[],"hold_state_map":{}}"##,
    )
    .unwrap();
    assert_eq!(older.led_base, LedBaseTuning::default());
    assert!(older.holds.is_empty());
    assert_eq!(parsed.hold_state_map[&43].role, HoldRole::Hand);
    assert_eq!(parsed.hold_state_map[&44].role, HoldRole::Finish);
    assert!(render_overlay(&parsed).is_ok());
}

#[test]
fn veil_covers_the_wall_and_punches_out_every_lit_hold() {
    let mut cfg = config("p1r42p2r43");
    cfg.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.6,
    });
    cfg.mark_style = Some(MarkStyle::NoMark);
    let data = render(&cfg);
    let wall = pixel(&data, 200, 200);
    assert_eq!(wall[3], 153, "0.6 alpha field colour on the wall");
    assert!(
        wall[2] > wall[0],
        "field colour is a blue-violet, premultiplied"
    );
    assert_eq!(alpha(&data, 100, 100), 0, "square hold centre is clear");
    assert_eq!(alpha(&data, 300, 100), 0, "circle fallback centre is clear");
    assert_eq!(alpha(&data, 300, 300), 153, "an unlit hold stays veiled");

    cfg.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.0,
    });
    assert_eq!(total_alpha(&render(&cfg)), 0, "opacity 0 paints nothing");
    // And a zero-opacity veil is a no-op on a full render, not just an empty one.
    let mut glow_no_veil = config("p1r42p2r43");
    glow_no_veil.veil = None;
    let mut glow_zero_veil = config("p1r42p2r43");
    glow_zero_veil.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.0,
    });
    assert_eq!(
        render(&glow_zero_veil),
        render(&glow_no_veil),
        "opacity 0 == no veil"
    );
}

#[test]
fn overlapping_silhouettes_are_cleared_once() {
    let mut cfg = config("p1r42p5r43");
    // A second square overlapping the first by half.
    cfg.holds.push(hold(5, 120.0, 100.0, Some(&SQUARE)));
    cfg.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.6,
    });
    cfg.mark_style = Some(MarkStyle::NoMark);
    let data = render(&cfg);
    assert_eq!(alpha(&data, 110, 100), 0, "overlap is clear, not re-filled");
    assert_eq!(alpha(&data, 90, 100), 0);
    assert_eq!(alpha(&data, 130, 100), 0);
}

#[test]
fn glow_is_bright_at_the_edge_fades_monotonically_and_ends_at_reach() {
    let data = render(&config("p1r42"));
    // Square spans 80..120; reach = min(0.7 × 20, 40 × 1.8) = 14.
    assert_eq!(alpha(&data, 100, 100), 0, "nothing on the hold surface");
    let first_outside = alpha(&data, 121, 100);
    assert!(
        first_outside >= 217,
        "edge pixel ≥ 0.85 alpha, got {first_outside}"
    );
    let mut previous = 255u8;
    for x in 121..=136 {
        let current = alpha(&data, x, 100);
        assert!(
            current <= previous,
            "alpha rose from {previous} to {current} at x={x}"
        );
        previous = current;
    }
    assert!(
        alpha(&data, 133, 100) > 0,
        "reach 14: the last lit pixel is x = 133"
    );
    assert_eq!(alpha(&data, 134, 100), 0, "and nothing past it");
    assert_eq!(alpha(&data, 150, 100), 0);
    let edge = pixel(&data, 121, 100);
    assert!(
        edge[1] > 200 && edge[0] < 10 && edge[2] < 10,
        "STARTING green, got {edge:?}"
    );
}

#[test]
fn neighbouring_glows_split_at_the_midline_and_keep_their_own_hue() {
    let mut cfg = config("p1r42p6r44");
    // Second square at x 140..180: edges 20 px apart, midline x = 130, reach 28 each.
    cfg.holds.push(hold(6, 160.0, 100.0, Some(&SQUARE)));
    cfg.glow.reach_scale = 2.0;
    let data = render(&cfg);
    let left = pixel(&data, 127, 100);
    let right = pixel(&data, 133, 100);
    assert!(
        left[3] > 0 && right[3] > 0,
        "both sides of the midline are lit"
    );
    assert!(
        left[1] > 0 && left[0] == 0,
        "left of the midline is STARTING green: {left:?}"
    );
    assert!(
        right[0] > 0 && right[2] > 0 && right[1] == 0,
        "right is FINISH magenta: {right:?}"
    );
    for x in 121..140 {
        let px = pixel(&data, x, 100);
        let mixed = px[0] > 0 && px[1] > 0;
        assert!(!mixed, "pixel {x} mixes both hues: {px:?}");
    }
}

#[test]
fn a_nearer_short_reach_hold_wins_the_partition_over_a_farther_long_reach_one() {
    // Sliver at x 298..302 (extent cap 7.2, ×2 = reach 14.4 → last lit x ≈ 316)
    // and a square whose left edge sits at x = 342 (reach 14 ×2 = 28 → its glow
    // would reach left to x = 314). The midline is x = 322: pixels 318..321
    // are nearer the sliver but beyond its reach, so they must stay EMPTY
    // rather than take the square's magenta — that is the partition.
    let mut cfg = config("p4r45p9r44");
    cfg.holds.push(hold(9, 362.0, 300.0, Some(&SQUARE)));
    cfg.glow.reach_scale = 2.0;
    let data = render(&cfg);
    for x in 318..=321 {
        assert_eq!(
            alpha(&data, x, 300),
            0,
            "x = {x} belongs to the sliver, which cannot reach it"
        );
    }
    let orange = pixel(&data, 310, 300);
    assert!(
        orange[3] > 0 && orange[0] > 0 && orange[2] == 0,
        "the sliver's FOOT orange within its reach: {orange:?}"
    );
    let magenta = pixel(&data, 325, 300);
    assert!(
        magenta[3] > 0 && magenta[0] > 0 && magenta[2] > 0,
        "past the midline the square's FINISH magenta: {magenta:?}"
    );
}

#[test]
fn veil_without_a_colour_parses_and_paints_the_default_field() {
    let parsed: RenderConfig = serde_json::from_str(
        r##"{"board_width":10,"board_height":10,"output_width":10,"frames":"","thumbnail":false,"holds":[],"hold_state_map":{},
             "render_mode":"boardsesh","veil":{"opacity":0.5}}"##,
    )
    .unwrap();
    assert_eq!(parsed.veil.as_ref().unwrap().color, "#181225");
    let (data, _, _) = render_overlay(&parsed).unwrap();
    assert_eq!(data[3], 128);
}

#[test]
fn small_hold_boost_widens_the_reach_and_the_extent_cap_clips_it() {
    // Tiny blob spans 94..106; boost 1.5 → reach 21 (last lit x = 126),
    // unboosted reach 14 (last lit x = 119).
    let boosted = render(&config("p3r43"));
    assert!(
        alpha(&boosted, 126, 300) > 0,
        "boost 1.5 carries the glow to 21 px"
    );
    assert_eq!(alpha(&boosted, 128, 300), 0);
    let mut unboosted = config("p3r43");
    unboosted.glow.small_hold_max_boost = 1.0;
    let unboosted_data = render(&unboosted);
    assert!(alpha(&unboosted_data, 119, 300) > 0);
    assert_eq!(
        alpha(&unboosted_data, 121, 300),
        0,
        "without the boost it stops at 14"
    );

    // Sliver spans x 298..302: shortest 4 → cap 7.2 px.
    let sliver = render(&config("p4r45"));
    assert!(alpha(&sliver, 304, 300) > 0);
    assert_eq!(
        alpha(&sliver, 312, 300),
        0,
        "capped well under the 14 px default"
    );
}

#[test]
fn plateau_holds_more_alpha_than_soft() {
    let soft = total_alpha(&render(&config("p1r42p2r43")));
    let mut cfg = config("p1r42p2r43");
    cfg.glow_falloff = GlowFalloff::Plateau;
    let plateau = total_alpha(&render(&cfg));
    assert!(plateau > soft * 13 / 10, "plateau {plateau} vs soft {soft}");
    // Same reach: nothing beyond it in either.
    assert_eq!(alpha(&render(&cfg), 136, 100), 0);
}

#[test]
fn ring_fallback_on_missing_or_malformed_outline() {
    let circle = render(&config("p2r43"));
    let mut malformed = config("p2r43");
    malformed.holds[1].outline = Some(vec![1.0, 2.0, 3.0]);
    assert_eq!(render(&malformed), circle, "odd-length outline → circle");
    malformed.holds[1].outline = Some(vec![0.0, 0.0, 1.0, 1.0]);
    assert_eq!(render(&malformed), circle, "two points → circle");
    malformed.holds[1].outline = Some(SQUARE.to_vec());
    assert_ne!(
        render(&malformed),
        circle,
        "a real outline changes the drawing"
    );
    // Circle: glow outside r = 20 (edge at x = 320), reach 14.
    assert_eq!(alpha(&circle, 300, 100), 0);
    assert!(alpha(&circle, 322, 100) > 200);
    assert_eq!(alpha(&circle, 336, 100), 0);
}

/// The alpha the plate shipped at in TestFlight build 6, before it was parked.
const PARKED_PLATE_OPACITY: f32 = 0.92;

/// Turn the plate's paint on for a test.
///
/// The shipped default is 0 — the effect is parked, see `LedBaseTuning` — so
/// every test that exercises the plate's DRAWING has to ask for it. Those tests
/// are kept, and kept green, because the annotation editor, the overrides and
/// the extractor all still write `led_inner`: bringing the paint back is meant
/// to be one constant, not one constant plus a re-audit of the geometry guards.
fn enable_plate(config: &mut RenderConfig) {
    config.led_base.opacity = PARKED_PLATE_OPACITY;
}

/// Hold 1's square silhouette spans 80..120 px; `SQUARE_INNER` leaves a 10 px
/// plate ring, so (85, 100) is on the plate and (100, 100) is the hold body.
fn plated(frames: &str) -> RenderConfig {
    let mut cfg = config(frames);
    cfg.holds[0].led_inner = Some(SQUARE_INNER.to_vec());
    enable_plate(&mut cfg);
    cfg
}

#[test]
fn the_led_base_plate_lights_the_rim_and_leaves_the_hold_body_alone() {
    let plain = render(&config("p1r42"));
    let plate = render(&plated("p1r42"));

    assert_eq!(alpha(&plain, 100, 100), 0, "glow alone never paints a hold");
    assert_eq!(
        alpha(&plate, 100, 100),
        0,
        "the hold proper stays the board's own art"
    );
    let rim = pixel(&plate, 85, 100);
    assert!(
        rim[3] > 230,
        "the plate ring is lit at nearly full strength, got {rim:?}"
    );
    assert_eq!(
        [rim[0], rim[1], rim[2]],
        [0, 235, 0],
        "the plate ring carries the role colour (#00FF00 at 0.92)"
    );
    // The plate reaches the silhouette edge all the way round, so the glow
    // outside is the one the whole silhouette produced.
    for x in [122, 128, 133] {
        assert_eq!(
            alpha(&plate, x, 100),
            alpha(&plain, x, 100),
            "glow at x={x} moved"
        );
    }
}

#[test]
fn a_malformed_or_oversized_led_inner_is_ignored_rather_than_drawn() {
    let plain = render(&config("p1r42"));
    let mut cfg = config("p1r42");
    for (label, ring) in [
        ("odd-length", vec![0.1, 0.2, 0.3]),
        ("two points", vec![-0.5, -0.5, 0.5, 0.5]),
        ("non-finite", vec![f32::NAN, -0.5, 0.5, -0.5, 0.5, 0.5]),
        // Exactly the silhouette: an even-odd fill of it would light nothing,
        // and a hold that reads as all-plate is not a plate.
        ("the silhouette itself", SQUARE.to_vec()),
        // Beside the hold, not inside it: even-odd would light a patch of wall.
        (
            "outside the silhouette",
            vec![2.0, -0.5, 3.0, -0.5, 3.0, 0.5, 2.0, 0.5],
        ),
        // 0.005r inside the edge: a legal polygon and a 0.1 px band. Accepting
        // it would dim the hold body under a rim nothing can see.
        (
            "a sub-pixel hairline",
            vec![-0.995, -0.995, 0.995, -0.995, 0.995, 0.995, -0.995, 0.995],
        ),
    ] {
        cfg.holds[0].led_inner = Some(ring);
        assert_eq!(render(&cfg), plain, "{label} led_inner changed the drawing");
    }
    // The silhouette itself is never in doubt: a bad plate ring must not push
    // the hold onto the circle fallback.
    cfg.holds[0].led_inner = Some(vec![f32::INFINITY; 8]);
    cfg.holds[0].outline = None;
    assert_ne!(render(&cfg), plain, "hold 1 without an outline is a circle");
}

#[test]
fn the_plate_is_opt_out_and_boards_without_one_are_untouched() {
    // `opacity: 0` has to be an OFF SWITCH for the whole treatment, not just
    // for the paint: the fill's dim and the glow's source read the same
    // setting. Checked under every mark style that draws something, because
    // the fill dim is invisible under `glow` and the glow source is invisible
    // under `fill` — the bug this pins showed up only in `fill`, where the
    // hold came out 40% darker with no rim to explain it.
    //
    // The `default` case is the one that matters most now: the effect is
    // PARKED, so a config that says nothing at all about `led_base` must draw
    // a board whose shards DO carry `led_inner` exactly the way the renderer
    // drew it before the plate existed. That is the property the parked build
    // rests on, and it is byte-for-byte.
    for style in [MarkStyle::Glow, MarkStyle::GlowFill, MarkStyle::Fill] {
        let mut plain = config("p1r42");
        plain.mark_style = Some(style);
        let plain_render = render(&plain);
        let mut off = plated("p1r42");
        off.mark_style = Some(style);
        for (label, opacity) in [
            ("the shipped default", LedBaseTuning::default().opacity),
            ("zero", 0.0),
            ("NaN", f32::NAN),
        ] {
            off.led_base.opacity = opacity;
            assert_eq!(
                render(&off),
                plain_render,
                "{label} opacity still moved the drawing under {style:?}"
            );
        }
    }
    assert_eq!(
        LedBaseTuning::default().opacity,
        0.0,
        "the plate is parked; bringing it back is this constant plus a native artifact rebuild"
    );

    // Hold 2 has no outline and hold 3 has one but no plate: neither can be
    // moved by the plate settings, whatever they say.
    let mut tuned = config("p2r43p3r44");
    tuned.led_base = LedBaseTuning {
        opacity: 1.0,
        interior_fill_scale: 0.1,
        glow_from_base: true,
    };
    assert_eq!(render(&tuned), render(&config("p2r43p3r44")));

    let mut none = plated("p1r42");
    none.mark_style = Some(MarkStyle::NoMark);
    assert_eq!(
        total_alpha(&render(&none)),
        0,
        "`none` means no mark, plate included"
    );
}

#[test]
fn the_fill_dims_under_the_plate_and_only_on_plated_holds() {
    let mut plain = config("p1r42p3r44");
    plain.mark_style = Some(MarkStyle::Fill);
    let mut plate = plated("p1r42p3r44");
    plate.mark_style = Some(MarkStyle::Fill);
    let plain_render = render(&plain);
    let plate_render = render(&plate);
    assert!(
        alpha(&plate_render, 100, 100) < alpha(&plain_render, 100, 100),
        "the plated hold's body is dimmed under its lit rim"
    );
    assert_eq!(
        alpha(&plate_render, 100, 300),
        alpha(&plain_render, 100, 300),
        "the unplated hold keeps the fill it always had"
    );
    plate.led_base.interior_fill_scale = 1.0;
    assert_eq!(
        alpha(&render(&plate), 100, 100),
        alpha(&plain_render, 100, 100),
        "scale 1 is the undimmed fill"
    );
}

#[test]
fn the_glow_comes_off_the_plate_rather_than_the_whole_silhouette() {
    // A plate along the bottom edge only: y 110..120 px of the 80..120 hold.
    const BOTTOM_ONLY: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, 1.0, 0.5, -1.0, 0.5];
    let mut cfg = config("p1r42");
    cfg.holds[0].led_inner = Some(BOTTOM_ONLY.to_vec());
    enable_plate(&mut cfg);
    let from_base = render(&cfg);
    cfg.led_base.glow_from_base = false;
    let from_silhouette = render(&cfg);

    assert_eq!(
        alpha(&from_silhouette, 100, 78),
        alpha(&from_silhouette, 100, 121),
        "the whole silhouette glows evenly above and below"
    );
    assert_eq!(
        alpha(&from_base, 100, 78),
        0,
        "no plate at the top edge, so no glow above the hold"
    );
    assert!(
        alpha(&from_base, 100, 121) > 200,
        "the plate is at the bottom edge, so the glow is"
    );
    assert_eq!(
        alpha(&from_base, 100, 121),
        alpha(&from_silhouette, 100, 121),
        "where the plate reaches the edge the glow is unchanged"
    );
}

#[test]
fn a_plate_too_thin_to_draw_is_rejected_by_every_consumer_together() {
    // 0.005r inside the edge: sub-pixel at r = 20. The paint, the fill's dim
    // and the glow's source have to agree it is not a plate — a plate the fill
    // dims for and the paint cannot draw is a hold that just went darker.
    // Checked under GlowFill, the thumbnail default, where all three run.
    const HAIRLINE: [f32; 8] = [-0.995, -0.995, 0.995, -0.995, 0.995, 0.995, -0.995, 0.995];
    for style in [MarkStyle::Glow, MarkStyle::GlowFill, MarkStyle::Fill] {
        let mut plain = config("p1r42");
        plain.mark_style = Some(style);
        let mut hairline = config("p1r42");
        hairline.mark_style = Some(style);
        hairline.holds[0].led_inner = Some(HAIRLINE.to_vec());
        assert_eq!(
            render(&hairline),
            render(&plain),
            "a sub-pixel plate moved the drawing under {style:?}"
        );
    }
}

/// A silhouette that is concave enough for its bounding box to contain bare
/// wall: a C opening to the right, 80..120 px with the 100..120 half of its
/// middle third bitten out.
const HOOK: [f32; 16] = [
    -1.0, -1.0, 1.0, -1.0, 1.0, -0.5, 0.0, -0.5, 0.0, 0.5, 1.0, 0.5, 1.0, 1.0, -1.0, 1.0,
];

/// Hold 1 wearing the hook silhouette. `RenderConfig` is not `Clone`, and each
/// of these tests needs two renders to compare.
fn hooked(led_inner: Option<&[f32]>) -> RenderConfig {
    let mut cfg = config("p1r42");
    cfg.holds[0].outline = Some(HOOK.to_vec());
    cfg.holds[0].led_inner = led_inner.map(<[f32]>::to_vec);
    enable_plate(&mut cfg);
    cfg
}

#[test]
fn a_ring_in_a_concave_silhouettes_hollow_never_lights_the_wall_inside_it() {
    // The ring sits in the C's mouth: inside the silhouette's BOX, outside the
    // silhouette. A box test alone accepts it, and an even-odd fill over two
    // disjoint rings then fills the hollow — bare wall, painted the role
    // colour, and seeded as glow sites on top.
    const IN_THE_HOLLOW: [f32; 8] = [0.2, -0.3, 0.8, -0.3, 0.8, 0.3, 0.2, 0.3];
    assert_eq!(
        render(&hooked(Some(&IN_THE_HOLLOW))),
        render(&hooked(None)),
        "a ring in the hollow lit the wall inside the silhouette's box"
    );
}

#[test]
fn a_plate_whose_edge_crosses_the_hollow_is_clipped_to_the_silhouette() {
    // Every vertex of this ring is inside the hook — both of the right-hand
    // ones sit in the C's arms — so the vertex check passes it. Its right EDGE
    // still runs straight across the mouth, and an unclipped even-odd fill
    // paints the strip of wall the box covers there. Only the clip catches
    // this one, which is why the clip is not just belt and braces.
    const ACROSS_THE_MOUTH: [f32; 8] = [-0.9, -0.6, 0.9, -0.6, 0.9, 0.6, -0.9, 0.6];
    let plain_render = render(&hooked(None));
    let plated_render = render(&hooked(Some(&ACROSS_THE_MOUTH)));

    // (110, 100) is r-relative (0.5, 0) — the middle of the C's mouth, and
    // inside the ring's box. Wall. A plate can only ever take light AWAY from
    // wall (the glow now comes off the rim, and the spine edge is not rim); it
    // must never add any. Unclipped this pixel came out at the plate's own
    // 0.92 role green.
    assert!(
        alpha(&plated_render, 110, 100) <= alpha(&plain_render, 110, 100),
        "the plate painted the wall its ring crossed: {:?} over {:?}",
        pixel(&plated_render, 110, 100),
        pixel(&plain_render, 110, 100),
    );
    // (81, 100) is (-0.95, 0): silhouette, outside the ring — real plate.
    assert!(
        alpha(&plated_render, 81, 100) > 230,
        "the plate itself still lights"
    );
}

#[test]
fn a_plate_inside_a_concave_silhouette_still_lights() {
    // The same hook with a real plate: a box inside the C's spine, which the
    // solid part of the silhouette contains at every y. The concavity guard
    // has to reject the hollow without rejecting the shape.
    const IN_THE_SPINE: [f32; 8] = [-0.8, -0.8, -0.2, -0.8, -0.2, 0.8, -0.8, 0.8];
    let plated_render = render(&hooked(Some(&IN_THE_SPINE)));
    // (82, 100) is r-relative (-0.9, 0): inside the spine, outside the ring.
    assert!(
        alpha(&plated_render, 82, 100) > 230,
        "the plate on a concave silhouette is lit"
    );
    // (90, 100) is (-0.5, 0): inside the ring, so it is the hold body.
    assert_eq!(
        alpha(&plated_render, 90, 100),
        0,
        "the hold proper inside a concave plate stays the art"
    );
}

#[test]
fn mark_styles_differ_and_none_draws_nothing() {
    let styles = [
        MarkStyle::Glow,
        MarkStyle::GlowFill,
        MarkStyle::Fill,
        MarkStyle::NoMark,
    ];
    let renders: Vec<Vec<u8>> = styles
        .iter()
        .map(|style| {
            let mut cfg = config("p1r42");
            cfg.mark_style = Some(*style);
            render(&cfg)
        })
        .collect();
    for (a, first) in renders.iter().enumerate() {
        for (b, second) in renders.iter().enumerate() {
            if a < b {
                assert_ne!(first, second, "{:?} vs {:?}", styles[a], styles[b]);
            }
        }
    }
    assert_eq!(
        total_alpha(&renders[3]),
        0,
        "none paints nothing without veil/glyph/led"
    );
    assert!(alpha(&renders[2], 100, 100) > 0, "fill covers the hold");
    assert_eq!(alpha(&renders[2], 130, 100), 0, "fill has no glow");
    assert!(
        alpha(&renders[1], 100, 100) > 0 && alpha(&renders[1], 122, 100) > 0,
        "glow-fill has both"
    );
}

#[test]
fn thumbnail_defaults_to_glow_fill_and_full_size_to_glow() {
    let mut thumb = config("p1r42");
    thumb.thumbnail = true;
    assert_eq!(effective_mark_style(&thumb), MarkStyle::GlowFill);
    let mut explicit = config("p1r42");
    explicit.thumbnail = true;
    explicit.mark_style = Some(MarkStyle::GlowFill);
    assert_eq!(render(&thumb), render(&explicit));
    assert_eq!(effective_mark_style(&config("p1r42")), MarkStyle::Glow);
    let mut unknown = config("p1r42");
    unknown.mark_style = Some(MarkStyle::Unknown);
    assert_eq!(effective_mark_style(&unknown), MarkStyle::Glow);
}

#[test]
fn white_lift_only_fires_below_the_normalise_target() {
    let mut dark = config("p1r42");
    dark.mark_style = Some(MarkStyle::Fill);
    dark.holds[0].silhouette_lightness = Some(0.2);
    let mut bright = config("p1r42");
    bright.mark_style = Some(MarkStyle::Fill);
    bright.holds[0].silhouette_lightness = Some(0.9);
    let mut unknown = config("p1r42");
    unknown.mark_style = Some(MarkStyle::Fill);
    let dark_px = pixel(&render(&dark), 100, 100);
    let bright_px = pixel(&render(&bright), 100, 100);
    assert_eq!(
        render(&bright),
        render(&unknown),
        "bright art is never pushed down"
    );
    assert!(
        dark_px[0] > bright_px[0],
        "dark art is lifted toward white: {dark_px:?} vs {bright_px:?}"
    );
}

#[test]
fn led_cover_lands_on_the_bright_blob_of_lit_and_unlit_holds() {
    let mut cfg = config("p1r42");
    cfg.mark_style = Some(MarkStyle::NoMark);
    cfg.led_cover = Some(LedCover::default());
    cfg.holds[1].led = Some([0.5, 0.0]); // unlit circle hold: blob 10 px right of centre
    cfg.holds[0].led = Some([0.0, 0.0]); // lit square: cover on the surface
    let data = render(&cfg);
    assert!(
        alpha(&data, 310, 100) > 200,
        "cover on the unlit hold's blob"
    );
    assert_eq!(alpha(&data, 290, 100), 0, "nothing on the other side");
    assert!(alpha(&data, 100, 100) > 200, "lit holds get the cover too");
    assert_eq!(alpha(&data, 300, 300), 0, "no led → no cover");
    let dark = pixel(&data, 310, 100);
    assert!(
        dark[0] < 20 && dark[1] < 20 && dark[2] < 30,
        "cover is the dark ink: {dark:?}"
    );
}

#[test]
fn glyphs_differ_per_role_and_never_leave_the_silhouette() {
    let mut renders = Vec::new();
    for code in [42, 43, 44, 45] {
        let mut cfg = config(&format!("p1r{code}"));
        cfg.mark_style = Some(MarkStyle::NoMark);
        cfg.glyphs = GlyphMode::Role;
        let data = render(&cfg);
        assert!(total_alpha(&data) > 0, "role {code} draws a glyph");
        for y in 0..SIZE {
            for x in 0..SIZE {
                if alpha(&data, x, y) > 0 {
                    assert!(
                        (79..=121).contains(&x) && (79..=121).contains(&y),
                        "role {code} painted outside at ({x},{y})"
                    );
                }
            }
        }
        renders.push(data);
    }
    for a in 0..renders.len() {
        for b in (a + 1)..renders.len() {
            assert_ne!(renders[a], renders[b]);
        }
    }
    // Bars run edge to edge: the STARTING bar reaches x = 81 and x = 119.
    assert!(alpha(&renders[0], 81, 100) > 0 && alpha(&renders[0], 119, 100) > 0);
    // The circle fallback is clipped too: a HAND bar on hold 2 (r = 20 at
    // 300,100) stays inside the circle, so nothing lands at the bar's ends
    // outside it or beside its ends where the circle curves in.
    let mut circle = config("p2r43");
    circle.mark_style = Some(MarkStyle::NoMark);
    circle.glyphs = GlyphMode::Role;
    let circle_data = render(&circle);
    assert!(total_alpha(&circle_data) > 0);
    for y in 0..SIZE {
        for x in 0..SIZE {
            if alpha(&circle_data, x, y) > 0 {
                let dx = x as f32 - 300.0;
                let dy = y as f32 - 100.0;
                assert!(
                    dx * dx + dy * dy <= 21.0 * 21.0,
                    "circle glyph painted outside r at ({x},{y})"
                );
            }
        }
    }
    assert_eq!(
        alpha(&renders[0], 100, 90),
        0,
        "STARTING bar is horizontal only"
    );
    assert!(alpha(&renders[1], 100, 90) > 0, "HAND bar is vertical");
    let mut off = config("p1r42");
    off.mark_style = Some(MarkStyle::NoMark);
    assert_eq!(total_alpha(&render(&off)), 0, "glyphs off by default");
}

#[test]
fn mirrored_climbs_use_the_partner_holds_outline() {
    let mut cfg = config("p1r42");
    cfg.holds[0].mirrored_hold_id = Some(7);
    cfg.holds.push(hold(
        7,
        300.0,
        300.0,
        Some(&[-0.25, -1.0, 0.25, -1.0, 0.25, 1.0, -0.25, 1.0]),
    ));
    cfg.holds[4].mirrored_hold_id = Some(1);
    cfg.mirrored = true;
    let data = render(&cfg);
    assert_eq!(
        alpha(&data, 121, 100),
        0,
        "nothing drawn at the original placement"
    );
    assert!(
        alpha(&data, 306, 300) > 0,
        "the partner's tall outline is lit at its own place"
    );
    assert_eq!(
        alpha(&data, 300, 300),
        0,
        "and the partner surface stays clear"
    );
    // The partner's own 10 px wide shape, not the original square: x = 312 is
    // 7 px outside the rectangle (glow) but would be inside a 40 px square.
    assert!(
        alpha(&data, 312, 300) > 0,
        "glow off the partner's narrow edge"
    );
}

#[test]
fn a_hold_in_the_corner_still_draws() {
    let mut cfg = config("p8r42");
    cfg.holds.push(hold(8, 5.0, 5.0, Some(&SQUARE)));
    let data = render(&cfg);
    assert!(alpha(&data, 27, 5) > 0, "glow off the visible right edge");
    assert!(alpha(&data, 5, 27) > 0, "glow off the visible bottom edge");
}

#[test]
fn classic_multipliers_scale_reach_and_glyph_width() {
    let mut bigger = config("p1r42");
    bigger.shape_size_multiplier = 2.0;
    assert!(
        alpha(&render(&bigger), 140, 100) > 0,
        "shape size 2 → reach 28"
    );
    assert_eq!(alpha(&render(&config("p1r42")), 140, 100), 0);

    let mut thin = config("p1r42");
    thin.mark_style = Some(MarkStyle::NoMark);
    thin.glyphs = GlyphMode::Role;
    thin.stroke_width_multiplier = 0.5;
    let mut thick = thin_clone(&thin);
    thick.stroke_width_multiplier = 2.0;
    assert!(total_alpha(&render(&thick)) > total_alpha(&render(&thin)) * 2);
}

fn thin_clone(base: &RenderConfig) -> RenderConfig {
    let mut cfg = config(&base.frames);
    cfg.mark_style = base.mark_style;
    cfg.glyphs = base.glyphs;
    cfg
}

#[test]
fn soft_disc_is_off_by_default_and_stays_off_the_hold_surface() {
    let plain = render(&config("p2r43"));
    let mut disc = config("p2r43");
    disc.glow.disc_opacity = 0.3;
    let with_disc = render(&disc);
    assert_ne!(with_disc, plain);
    assert_eq!(alpha(&with_disc, 300, 100), 0, "cleared off the silhouette");
}

#[test]
fn above_marker_roles_keep_the_classic_pip() {
    let mut cfg = config("p2r46");
    cfg.hold_state_map.insert(
        46,
        HoldStateInfo {
            color: "#FFE066".into(),
            render_style: crate::types::HoldRenderStyle::AboveMarker,
            shape: Default::default(),
            role: HoldRole::Unknown,
        },
    );
    let data = render(&cfg);
    // Classic pip: centre at cy - 1.15 r = 77, radius 9.6.
    assert!(alpha(&data, 300, 77) > 0);
    assert_eq!(
        alpha(&data, 300, 100),
        0,
        "no silhouette mark for an above-marker role"
    );
}

#[test]
fn empty_frames_render_nothing_even_with_a_veil_disabled() {
    let mut cfg = config("");
    cfg.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.6,
    });
    // A veil with no lit holds is still the veil: the caller decides whether
    // to send one for an empty climb.
    assert_eq!(alpha(&render(&cfg), 200, 200), 153);
    assert_eq!(total_alpha(&render(&config(""))), 0);
}

/// Host-side ballpark for the phone-size render (an iPhone 16 Pro draws the
/// board 1206 px wide): 16 lit holds spread over a Kilter-sized board, with a
/// veil, LED covers on 200 placements, the glow and the glyphs. Run with
/// `cargo test --release -- --ignored --nocapture phone_size`.
#[test]
#[ignore]
fn phone_size_render_timing() {
    let mut hold_state_map = HashMap::new();
    hold_state_map.insert(42, state("#00FF00", HoldRole::Starting));
    hold_state_map.insert(43, state("#00FFFF", HoldRole::Hand));
    let mut holds = Vec::new();
    let mut frames = String::new();
    for index in 0..200u32 {
        let cx = 60.0 + (index % 20) as f32 * 50.0;
        let cy = 60.0 + (index / 20) as f32 * 130.0;
        let mut placement = hold(index + 1, cx, cy, Some(&SQUARE));
        placement.r = 24.0;
        placement.led = Some([0.0, 0.0]);
        holds.push(placement);
        if index % 12 == 0 {
            frames.push_str(&format!(
                "p{}r{}",
                index + 1,
                if index % 24 == 0 { 42 } else { 43 }
            ));
        }
    }
    let mut cfg = config(&frames);
    cfg.board_width = 1080.0;
    cfg.board_height = 1350.0;
    cfg.output_width = 1206;
    cfg.holds = holds;
    cfg.hold_state_map = hold_state_map;
    cfg.veil = Some(Veil {
        color: "#181225".into(),
        opacity: 0.6,
    });
    cfg.led_cover = Some(LedCover::default());
    cfg.glyphs = GlyphMode::Role;
    let started = std::time::Instant::now();
    let rounds = 5;
    for _ in 0..rounds {
        let (data, width, height) = render_overlay(&cfg).unwrap();
        assert_eq!((width, height), (1206, 1508));
        assert!(data.iter().skip(3).step_by(4).any(|alpha| *alpha > 0));
    }
    let per_render = started.elapsed() / rounds;
    println!(
        "PHONE_SIZE_RENDER {} lit holds, {:?} per render",
        frames.matches('p').count(),
        per_render
    );
    let mut glow_only = config(&cfg.frames);
    glow_only.board_width = 1080.0;
    glow_only.board_height = 1350.0;
    glow_only.output_width = 1206;
    glow_only.holds = cfg.holds.clone();
    glow_only.hold_state_map = cfg.hold_state_map.clone();
    let started = std::time::Instant::now();
    for _ in 0..rounds {
        render_overlay(&glow_only).unwrap();
    }
    println!(
        "PHONE_SIZE_GLOW_ONLY {:?} per render",
        started.elapsed() / rounds
    );
    let mut thumb = glow_only;
    thumb.output_width = 200;
    thumb.thumbnail = true;
    let started = std::time::Instant::now();
    for _ in 0..rounds {
        render_overlay(&thumb).unwrap();
    }
    println!(
        "THUMBNAIL_200PX {:?} per render",
        started.elapsed() / rounds
    );
}

// ---------------------------------------------------------------------------
// The advanced-glow effects (falloff gamma, dither, two-tone, rim, merge,
// seam, spill). Every knob defaults to neutral; the first test pins that an
// old-shape config parses to those neutral values.
// ---------------------------------------------------------------------------

#[test]
fn old_shape_glow_json_parses_to_neutral_defaults() {
    let parsed: GlowTuning = serde_json::from_str("{}").unwrap();
    assert_eq!(parsed, GlowTuning::default());
    let partial: GlowTuning = serde_json::from_str(r#"{"reach_scale": 1.3}"#).unwrap();
    assert_eq!(partial.reach_scale, 1.3);
    assert_eq!(partial.falloff_gamma, 1.0);
    assert_eq!(partial.dither, 0.0);
    assert_eq!(partial.core_whiten, 0.0);
    assert_eq!(partial.rim_width_fraction, 0.0);
    assert_eq!(partial.merge_softness, 0.0);
    assert_eq!(partial.seam_blend_fraction, 0.0);
    assert_eq!(partial.spill_boost, 0.0);
}

#[test]
fn falloff_gamma_pulls_the_light_in() {
    let base_config = config("p1r42");
    let base = render(&base_config);
    let mut shaped_config = config("p1r42");
    shaped_config.glow.falloff_gamma = 2.0;
    let shaped = render(&shaped_config);
    // Mid-glow (distance ~6.5 of reach 14): alpha squared drops hard.
    assert!(
        alpha(&shaped, 100, 73) < alpha(&base, 100, 73) - 20,
        "gamma 2 dims the mid-glow: {} vs {}",
        alpha(&shaped, 100, 73),
        alpha(&base, 100, 73)
    );
    // The silhouette edge stays bright either way (alpha ~1 -> 1^2 = 1).
    assert!(alpha(&shaped, 100, 79) > 180);
}

#[test]
fn dither_perturbs_alpha_within_its_amplitude() {
    let base = render(&config("p1r42"));
    let mut dithered_config = config("p1r42");
    dithered_config.glow.dither = 0.1;
    let dithered = render(&dithered_config);
    let mut any_difference = false;
    for (base_px, dithered_px) in base.chunks(4).zip(dithered.chunks(4)) {
        let delta = (base_px[3] as i32 - dithered_px[3] as i32).abs();
        assert!(delta <= 14, "dither stays within ±amplitude/2: {delta}");
        if delta > 0 {
            any_difference = true;
        }
    }
    assert!(any_difference, "dither must actually perturb the ramp");
}

#[test]
fn two_tone_whitens_the_core_and_deepens_the_fringe() {
    let base = render(&config("p1r42"));
    let mut toned_config = config("p1r42");
    toned_config.glow.core_whiten = 0.8;
    toned_config.glow.core_share = 0.3;
    toned_config.glow.fringe_deepen = 0.8;
    let toned = render(&toned_config);
    // Just off the edge: the green glow gains red on its way to white.
    assert_eq!(
        pixel(&base, 100, 78)[0],
        0,
        "baseline green glow has no red"
    );
    assert!(
        pixel(&toned, 100, 78)[0] > 60,
        "whitened core carries red: {}",
        pixel(&toned, 100, 78)[0]
    );
    // Out at the fringe the green channel deepens toward the dark hue.
    assert!(
        pixel(&toned, 100, 68)[1] < pixel(&base, 100, 68)[1],
        "fringe deepens: {} vs {}",
        pixel(&toned, 100, 68)[1],
        pixel(&base, 100, 68)[1]
    );
}

#[test]
fn neon_rim_hugs_the_silhouette_edge() {
    let base = render(&config("p1r42"));
    let mut rimmed_config = config("p1r42");
    rimmed_config.glow.rim_width_fraction = 0.15; // 3 px on r = 20
    rimmed_config.glow.rim_opacity = 1.0;
    rimmed_config.glow.rim_whiten = 1.0;
    let rimmed = render(&rimmed_config);
    assert_eq!(pixel(&base, 100, 78)[0], 0);
    assert!(
        pixel(&rimmed, 100, 78)[0] > 200,
        "rim band is near-white: {}",
        pixel(&rimmed, 100, 78)[0]
    );
    assert_eq!(
        pixel(&rimmed, 100, 70)[0],
        0,
        "past the rim width the glow is the plain role colour"
    );
    assert_eq!(
        alpha(&rimmed, 100, 100),
        0,
        "the rim never paints the hold surface"
    );
}

/// Two 40 px squares 10 px apart on one row, both lit.
fn two_square_config(frames: &str) -> RenderConfig {
    let mut cfg = config(frames);
    cfg.holds = vec![
        hold(1, 175.0, 200.0, Some(&SQUARE)),
        hold(2, 225.0, 200.0, Some(&SQUARE)),
    ];
    cfg
}

#[test]
fn merge_softness_bridges_same_colour_neighbours() {
    let base = render(&two_square_config("p1r43p2r43"));
    let mut merged_config = two_square_config("p1r43p2r43");
    merged_config.glow.merge_softness = 0.5;
    let merged = render(&merged_config);
    // The gap midpoint sits ~5 px from each silhouette; smooth-min pulls the
    // combined field closer and the bridge brightens.
    assert!(
        alpha(&merged, 200, 200) > alpha(&base, 200, 200) + 20,
        "merge bridges the gap: {} vs {}",
        alpha(&merged, 200, 200),
        alpha(&base, 200, 200)
    );
    // Far side of the left hold, no neighbour in range: untouched.
    assert_eq!(
        alpha(&merged, 150, 200),
        alpha(&base, 150, 200),
        "an isolated edge is unchanged"
    );
}

#[test]
fn seam_blend_crossfades_between_different_colours() {
    // Green STARTING beside cyan HAND: the baseline switches colour on the
    // bisector, the blend carries both across it.
    let base = render(&two_square_config("p1r42p2r43"));
    let mut blended_config = two_square_config("p1r42p2r43");
    blended_config.glow.seam_blend_fraction = 0.6;
    let blended = render(&blended_config);
    let base_midpoint = pixel(&base, 200, 200);
    let blended_midpoint = pixel(&blended, 200, 200);
    // Baseline: winner-take-all, so blue is either ~0 (green won) or ~green
    // (cyan won). Blended: blue sits in between.
    let base_ratio = base_midpoint[2] as f32 / base_midpoint[1].max(1) as f32;
    let blended_ratio = blended_midpoint[2] as f32 / blended_midpoint[1].max(1) as f32;
    assert!(
        !(0.1..=0.9).contains(&base_ratio),
        "baseline is one colour or the other: {base_ratio}"
    );
    assert!(
        (0.25..=0.75).contains(&blended_ratio),
        "seam carries both colours: {blended_ratio}"
    );
}

#[test]
fn spill_boost_brightens_glow_over_unlit_silhouettes() {
    let spill_layout = |spill_boost: f32| {
        let mut cfg = config("p1r42");
        cfg.holds = vec![
            hold(1, 100.0, 100.0, Some(&SQUARE)),
            // Unlit traced hold whose left edge (x = 125) sits inside the lit
            // hold's 14 px reach.
            hold(6, 145.0, 100.0, Some(&SQUARE)),
        ];
        cfg.glow.spill_boost = spill_boost;
        cfg
    };
    let base = render(&spill_layout(0.0));
    let spilled = render(&spill_layout(1.0));
    assert!(
        alpha(&spilled, 128, 100) > alpha(&base, 128, 100) + 20,
        "glow over the unlit hold brightens: {} vs {}",
        alpha(&spilled, 128, 100),
        alpha(&base, 128, 100)
    );
    assert_eq!(
        alpha(&spilled, 100, 73),
        alpha(&base, 100, 73),
        "glow over bare wall is untouched"
    );
}
