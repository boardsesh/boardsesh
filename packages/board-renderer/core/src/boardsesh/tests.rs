use std::collections::HashMap;

use super::*;
use crate::renderer::render_overlay;
use crate::types::{
    BoardRenderMode, GlowFalloff, GlowTuning, GlyphMode, GlyphTuning, HoldMarkerShape, HoldRole,
    HoldStateInfo, LedCover, MarkStyle, Veil,
};

const SIZE: u32 = 400;
const SQUARE: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0];
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
      "holds": [{"id": 1, "cx": 100, "cy": 100, "r": 20, "outline": [-1,-1,1,-1,1,1,-1,1], "led": [0.5, 0.0], "silhouette_lightness": 0.3},
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
    assert_eq!(parsed.holds[0].led, Some([0.5, 0.0]));
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
