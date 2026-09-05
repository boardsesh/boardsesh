// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

use std::collections::HashMap;
use tiny_skia::{Color as SkiaColor, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

use crate::frames_parser::parse_frames;
use crate::types::{BoardRenderMode, HoldData, HoldMarkerShape, HoldRenderStyle, RenderConfig};

// Per-shape scale so every shape covers the same filled AREA as a circle of the
// given radius (issue #3204). MUST stay in sync with SHAPE_AREA_SCALE in
// packages/mobile/src/components/board-renderer/HoldMarkerShape.tsx.
fn shape_area_scale(shape: HoldMarkerShape) -> f32 {
    match shape {
        HoldMarkerShape::TriangleUp | HoldMarkerShape::TriangleDown => 1.5552,
        HoldMarkerShape::Square => 1.0808,
        HoldMarkerShape::Diamond => 1.2533,
        HoldMarkerShape::Octagon => 1.0539,
        HoldMarkerShape::Circle | HoldMarkerShape::Unknown => 1.0,
    }
}

// Fraction of the (scaled) circumradius used to round triangle corners — matches
// TRIANGLE_CORNER_RATIO in the JS renderer.
const TRIANGLE_CORNER_RATIO: f32 = 0.2;

// A point `dist` along the edge from `from` toward `to`.
fn towards(from: (f32, f32), to: (f32, f32), dist: f32) -> (f32, f32) {
    let dx = to.0 - from.0;
    let dy = to.1 - from.1;
    let len = (dx * dx + dy * dy).sqrt().max(f32::EPSILON);
    (from.0 + dx / len * dist, from.1 + dy / len * dist)
}

// Rounded-corner path for a convex polygon: stop short of each corner and
// quad-curve through it (control = the true vertex). Matches roundedPolygonPath
// in the JS renderer.
fn rounded_polygon_path(vertices: &[(f32, f32)], corner_radius: f32) -> Option<tiny_skia::Path> {
    let count = vertices.len();
    let mut builder = PathBuilder::new();
    for i in 0..count {
        let prev = vertices[(i + count - 1) % count];
        let curr = vertices[i];
        let next = vertices[(i + 1) % count];
        let entry = towards(curr, prev, corner_radius);
        let exit = towards(curr, next, corner_radius);
        if i == 0 {
            builder.move_to(entry.0, entry.1);
        } else {
            builder.line_to(entry.0, entry.1);
        }
        builder.quad_to(curr.0, curr.1, exit.0, exit.1);
    }
    builder.close();
    builder.finish()
}

fn marker_shape_path(
    shape: HoldMarkerShape,
    cx: f32,
    cy: f32,
    base_r: f32,
) -> Option<tiny_skia::Path> {
    // Equal-area scaling — circle is the reference (scale 1.0), others grow.
    let r = base_r * shape_area_scale(shape);
    match shape {
        HoldMarkerShape::Circle => PathBuilder::from_circle(cx, cy, r),
        HoldMarkerShape::TriangleUp => rounded_polygon_path(
            &[
                (cx, cy - r),
                (cx + r * 0.866, cy + r * 0.5),
                (cx - r * 0.866, cy + r * 0.5),
            ],
            r * TRIANGLE_CORNER_RATIO,
        ),
        HoldMarkerShape::TriangleDown => rounded_polygon_path(
            &[
                (cx - r * 0.866, cy - r * 0.5),
                (cx + r * 0.866, cy - r * 0.5),
                (cx, cy + r),
            ],
            r * TRIANGLE_CORNER_RATIO,
        ),
        HoldMarkerShape::Square => {
            let half_side = r * 0.82;
            let mut builder = PathBuilder::new();
            builder.move_to(cx - half_side, cy - half_side);
            builder.line_to(cx + half_side, cy - half_side);
            builder.line_to(cx + half_side, cy + half_side);
            builder.line_to(cx - half_side, cy + half_side);
            builder.close();
            builder.finish()
        }
        HoldMarkerShape::Diamond => {
            let mut builder = PathBuilder::new();
            builder.move_to(cx, cy - r);
            builder.line_to(cx + r, cy);
            builder.line_to(cx, cy + r);
            builder.line_to(cx - r, cy);
            builder.close();
            builder.finish()
        }
        // Regular octagon, flat top/bottom (stop-sign orientation): vertices at
        // angle = π/8 + i·π/4. Shared geometry with the JS SVG renderer.
        HoldMarkerShape::Octagon => {
            let mut builder = PathBuilder::new();
            for i in 0..8 {
                let angle = std::f32::consts::PI / 8.0 + (i as f32) * std::f32::consts::PI / 4.0;
                let x = cx + r * angle.cos();
                let y = cy + r * angle.sin();
                if i == 0 {
                    builder.move_to(x, y);
                } else {
                    builder.line_to(x, y);
                }
            }
            builder.close();
            builder.finish()
        }
        // Unknown future shape from a newer JS bundle: fall back to a circle.
        HoldMarkerShape::Unknown => PathBuilder::from_circle(cx, cy, r),
    }
}

/// Largest overlay either mode will allocate: 64 megapixels (256 MB RGBA),
/// far above any board at any device width, and far below the 6.9 TB a
/// `board_width` of 0 used to ask for before aborting the process.
const MAX_OUTPUT_PIXELS: u64 = 64 * 1024 * 1024;

/// The overlay's pixel size for a config, or why it cannot be rendered.
pub fn output_size(config: &RenderConfig) -> Result<(u32, u32), String> {
    let positive = |value: f32| value.is_finite() && value > 0.0;
    if !positive(config.board_width) || !positive(config.board_height) {
        return Err("Board dimensions must be finite and positive".into());
    }
    let output_width = config.output_width;
    let output_height =
        (output_width as f32 * config.board_height / config.board_width).round() as u32;
    if output_width == 0 || output_height == 0 {
        return Err("Output dimensions must be non-zero".into());
    }
    if output_width as u64 * output_height as u64 > MAX_OUTPUT_PIXELS {
        return Err("Output dimensions exceed the renderer's limit".into());
    }
    Ok((output_width, output_height))
}

/// Render a transparent overlay with hold circles drawn on it.
/// Returns RGBA pixel data and dimensions (width, height).
pub fn render_overlay(config: &RenderConfig) -> Result<(Vec<u8>, u32, u32), String> {
    if config.render_mode == BoardRenderMode::Aura {
        return crate::aura::render(config);
    }
    let (output_width, output_height) = output_size(config)?;

    let mut pixmap = Pixmap::new(output_width, output_height).ok_or("Failed to create pixmap")?;

    // Scale factors from SVG viewBox coords to pixel coords
    let scale_x = output_width as f32 / config.board_width;
    let scale_y = output_height as f32 / config.board_height;

    // Parse the frames string to get lit holds
    let parsed_holds = parse_frames(&config.frames, &config.hold_state_map);

    // Build a lookup map from hold ID to HoldData for mirroring
    let mut holds_by_id: HashMap<u32, &HoldData> = HashMap::with_capacity(config.holds.len());
    for h in &config.holds {
        holds_by_id.insert(h.id, h);
    }

    // Lift constant state out of the per-hold loop
    let transform = Transform::identity();
    let stroke_width_multiplier = if config.stroke_width_multiplier.is_finite() {
        config.stroke_width_multiplier.clamp(0.5, 2.0)
    } else {
        1.0
    };
    let stroke_width =
        (if config.thumbnail { 8.0 } else { 6.0 }) * scale_x * stroke_width_multiplier;
    let shape_size_multiplier = if config.shape_size_multiplier.is_finite() {
        config.shape_size_multiplier.clamp(0.5, 2.0)
    } else {
        1.0
    };

    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };

    let stroke_style = Stroke {
        width: stroke_width,
        ..Stroke::default()
    };

    for parsed in &parsed_holds {
        let hold = match holds_by_id.get(&parsed.hold_id) {
            Some(h) => *h,
            None => continue,
        };

        // Handle mirroring: use mirrored hold's coordinates
        let render_hold = if config.mirrored {
            if let Some(mirrored_id) = hold.mirrored_hold_id {
                match holds_by_id.get(&mirrored_id) {
                    Some(h) => *h,
                    None => hold,
                }
            } else {
                hold
            }
        } else {
            hold
        };

        // Scale SVG coords to pixel coords
        let cx = render_hold.cx * scale_x;
        let cy = render_hold.cy * scale_y;
        let r = render_hold.r * scale_x;
        let marker_r = r * shape_size_multiplier;

        let color = parsed.color;

        match parsed.render_style {
            HoldRenderStyle::Circle => {
                let path = match marker_shape_path(parsed.shape, cx, cy, marker_r) {
                    Some(p) => p,
                    None => continue,
                };

                // Thumbnail: filled circle with 0.3 opacity + stroke
                // Full size: stroke only, no fill
                if config.thumbnail {
                    paint.set_color(SkiaColor::from_rgba8(color.r, color.g, color.b, 77)); // 0.3 * 255 ≈ 77
                    pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
                }

                paint.set_color(SkiaColor::from_rgba8(color.r, color.g, color.b, 255));
                pixmap.stroke_path(&path, &paint, &stroke_style, transform, None);
            }
            HoldRenderStyle::AboveMarker => {
                let marker_radius = (r * if config.thumbnail { 0.62 } else { 0.48 }).max(2.0);
                let marker_cy = cy - (r * if config.thumbnail { 1.28 } else { 1.15 });
                let path = match PathBuilder::from_circle(cx, marker_cy, marker_radius) {
                    Some(p) => p,
                    None => continue,
                };

                paint.set_color(SkiaColor::from_rgba8(color.r, color.g, color.b, 255));
                pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);

                let marker_stroke = Stroke {
                    width: (stroke_width * 0.45).max(2.0),
                    ..Stroke::default()
                };
                pixmap.stroke_path(&path, &paint, &marker_stroke, transform, None);
            }
        }
    }

    let data = pixmap.data().to_vec();
    Ok((data, output_width, output_height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HoldStateInfo;

    fn test_config() -> RenderConfig {
        let mut hold_state_map = HashMap::new();
        hold_state_map.insert(
            42,
            HoldStateInfo {
                color: "#00FF00".into(),
                render_style: Default::default(),
                shape: Default::default(),
                role: Default::default(),
            },
        );
        hold_state_map.insert(
            43,
            HoldStateInfo {
                color: "#00FFFF".into(),
                render_style: Default::default(),
                shape: Default::default(),
                role: Default::default(),
            },
        );
        hold_state_map.insert(
            44,
            HoldStateInfo {
                color: "#FF00FF".into(),
                render_style: Default::default(),
                shape: Default::default(),
                role: Default::default(),
            },
        );

        RenderConfig {
            board_width: 1080.0,
            board_height: 1350.0,
            output_width: 300,
            frames: "p1r42p2r43p3r44".into(),
            mirrored: false,
            thumbnail: false,
            stroke_width_multiplier: 1.0,
            shape_size_multiplier: 1.0,
            holds: vec![
                HoldData {
                    id: 1,
                    mirrored_hold_id: None,
                    cx: 200.0,
                    cy: 300.0,
                    r: 20.0,
                    outline: None,
                    led_inner: None,
                    led: None,
                    silhouette_lightness: None,
                },
                HoldData {
                    id: 2,
                    mirrored_hold_id: None,
                    cx: 500.0,
                    cy: 600.0,
                    r: 20.0,
                    outline: None,
                    led_inner: None,
                    led: None,
                    silhouette_lightness: None,
                },
                HoldData {
                    id: 3,
                    mirrored_hold_id: None,
                    cx: 800.0,
                    cy: 900.0,
                    r: 20.0,
                    outline: None,
                    led_inner: None,
                    led: None,
                    silhouette_lightness: None,
                },
            ],
            hold_state_map,
            render_mode: Default::default(),
            veil: None,
            mark_style: None,
            glow_falloff: Default::default(),
            glow: Default::default(),
            fill: Default::default(),
            glyphs: Default::default(),
            glyph: Default::default(),
            led_cover: None,
            led_base: Default::default(),
        }
    }

    #[test]
    fn test_render_produces_correct_dimensions() {
        let config = test_config();
        let (_, width, height) = render_overlay(&config).unwrap();
        assert_eq!(width, 300);
        assert_eq!(height, 375); // 300 * 1350/1080
    }

    #[test]
    fn test_render_has_non_transparent_pixels() {
        let config = test_config();
        let (data, _, _) = render_overlay(&config).unwrap();
        // Check that at least some pixels have non-zero alpha
        let has_colored_pixels = data.chunks(4).any(|pixel| pixel[3] > 0);
        assert!(
            has_colored_pixels,
            "Overlay should have non-transparent pixels"
        );
    }

    #[test]
    fn test_render_empty_frames() {
        let mut config = test_config();
        config.frames = String::new();
        let (data, _, _) = render_overlay(&config).unwrap();
        // All pixels should be fully transparent
        let all_transparent = data.chunks(4).all(|pixel| pixel[3] == 0);
        assert!(
            all_transparent,
            "Empty frames should produce fully transparent image"
        );
    }

    #[test]
    fn test_render_zero_dimensions_fails() {
        let mut config = test_config();
        config.output_width = 0;
        assert!(render_overlay(&config).is_err());
    }

    #[test]
    fn test_render_rejects_degenerate_board_dimensions_instead_of_aborting() {
        let mut zero_width = test_config();
        zero_width.board_width = 0.0;
        assert!(render_overlay(&zero_width).is_err());
        let mut negative_height = test_config();
        negative_height.board_height = -10.0;
        assert!(render_overlay(&negative_height).is_err());
        let mut absurd = test_config();
        absurd.output_width = 100_000;
        absurd.board_height = 100_000.0;
        absurd.board_width = 100.0;
        assert!(render_overlay(&absurd).is_err());
        let mut aura = test_config();
        aura.render_mode = BoardRenderMode::Aura;
        aura.board_width = 0.0;
        assert!(render_overlay(&aura).is_err());
    }

    #[test]
    fn test_render_above_marker_differs_from_circle_render() {
        let mut aux_config = test_config();
        aux_config.frames = "p1r46".into();
        aux_config.hold_state_map.insert(
            46,
            HoldStateInfo {
                color: "#FFE066".into(),
                render_style: HoldRenderStyle::AboveMarker,
                shape: Default::default(),
                role: Default::default(),
            },
        );

        let mut circle_config = test_config();
        circle_config.frames = "p1r46".into();
        circle_config.hold_state_map.insert(
            46,
            HoldStateInfo {
                color: "#FFE066".into(),
                render_style: HoldRenderStyle::Circle,
                shape: Default::default(),
                role: Default::default(),
            },
        );

        let (aux_data, _, _) = render_overlay(&aux_config).unwrap();
        let (circle_data, _, _) = render_overlay(&circle_config).unwrap();

        assert_ne!(aux_data, circle_data);
    }

    #[test]
    fn test_render_marker_shapes_produce_distinct_output() {
        let circle_data = render_single_shape(HoldMarkerShape::Circle);

        for shape in [
            HoldMarkerShape::TriangleUp,
            HoldMarkerShape::TriangleDown,
            HoldMarkerShape::Square,
            HoldMarkerShape::Diamond,
            HoldMarkerShape::Octagon,
        ] {
            let data = render_single_shape(shape);
            assert!(
                data.chunks(4).any(|pixel| pixel[3] > 0),
                "shape {shape:?} should draw non-transparent pixels"
            );
            assert_ne!(
                data, circle_data,
                "shape {shape:?} should differ from circle"
            );
        }
    }

    #[test]
    fn test_render_brush_thickness_changes_output() {
        let mut thin_config = test_config();
        thin_config.frames = "p1r42".into();
        thin_config.stroke_width_multiplier = 0.5;

        let mut thick_config = test_config();
        thick_config.frames = "p1r42".into();
        thick_config.stroke_width_multiplier = 2.0;

        let (thin_data, _, _) = render_overlay(&thin_config).unwrap();
        let (thick_data, _, _) = render_overlay(&thick_config).unwrap();

        assert_ne!(thin_data, thick_data);
    }

    #[test]
    fn test_render_shape_size_changes_output() {
        let mut small_config = test_config();
        small_config.frames = "p1r42".into();
        small_config.shape_size_multiplier = 0.5;

        let mut large_config = test_config();
        large_config.frames = "p1r42".into();
        large_config.shape_size_multiplier = 2.0;

        let (small_data, _, _) = render_overlay(&small_config).unwrap();
        let (large_data, _, _) = render_overlay(&large_config).unwrap();

        assert_ne!(small_data, large_data);
    }

    #[test]
    fn test_octagon_shape_deserialises() {
        let info: HoldStateInfo =
            serde_json::from_str(r##"{"color":"#00FF00","shape":"octagon"}"##).unwrap();
        assert_eq!(info.shape, HoldMarkerShape::Octagon);
    }

    #[test]
    fn test_unknown_shape_falls_back_instead_of_failing_parse() {
        // A newer JS bundle could send a shape this binary doesn't know; it must
        // deserialise to Unknown (rendered as a circle), not error the whole config.
        let info: HoldStateInfo =
            serde_json::from_str(r##"{"color":"#00FF00","shape":"hexagram-from-the-future"}"##)
                .unwrap();
        assert_eq!(info.shape, HoldMarkerShape::Unknown);
        let data = render_single_shape(HoldMarkerShape::Unknown);
        assert!(data.chunks(4).any(|pixel| pixel[3] > 0));
    }

    #[test]
    fn test_equal_area_triangle_close_to_circle() {
        // After #3204's equal-area normalization a triangle marker covers a
        // comparable filled area to the circle (it was ~40% before). Loose bounds
        // because the triangle's longer perimeter adds stroke pixels.
        let count = |data: &[u8]| data.chunks(4).filter(|pixel| pixel[3] > 0).count() as f32;
        let circle = count(&render_single_shape(HoldMarkerShape::Circle));
        let triangle = count(&render_single_shape(HoldMarkerShape::TriangleUp));
        assert!(
            triangle > 0.7 * circle && triangle < 1.6 * circle,
            "triangle area {triangle} should be close to circle {circle}"
        );
    }

    fn render_single_shape(shape: HoldMarkerShape) -> Vec<u8> {
        let mut config = test_config();
        config.frames = "p1r42".into();
        config.hold_state_map.insert(
            42,
            HoldStateInfo {
                color: "#00FF00".into(),
                render_style: HoldRenderStyle::Circle,
                shape,
                role: Default::default(),
            },
        );
        let (data, _, _) = render_overlay(&config).unwrap();
        data
    }

    fn fnv1a(data: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in data {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    // The classic renderer's pixels are pinned to what origin/main drew before
    // the Aura mode landed (issue #2202): the new mode dispatches away
    // before the first classic line runs, so any drift here is a regression in
    // the drawing every existing overlay cache was built from.
    #[test]
    fn classic_render_is_byte_identical_to_the_pre_aura_renderer() {
        let default = test_config();
        let mut thumb = test_config();
        thumb.thumbnail = true;
        let mut brush = test_config();
        brush.stroke_width_multiplier = 2.0;
        let mut sized = test_config();
        sized.shape_size_multiplier = 1.5;
        sized.hold_state_map.insert(
            42,
            HoldStateInfo {
                color: "#00FF00".into(),
                render_style: Default::default(),
                shape: HoldMarkerShape::Diamond,
                role: Default::default(),
            },
        );
        let mut aux = test_config();
        aux.frames = "p1r46p2r43".into();
        aux.hold_state_map.insert(
            46,
            HoldStateInfo {
                color: "#FFE066".into(),
                render_style: HoldRenderStyle::AboveMarker,
                shape: Default::default(),
                role: Default::default(),
            },
        );
        let pinned: [(&str, RenderConfig, u64); 5] = [
            ("default", default, 0xa7021078f6d3e015),
            ("thumb", thumb, 0xcd47e4f3ae20c93c),
            ("brush", brush, 0xfa54a72bfcfd94f5),
            ("sized-diamond", sized, 0xd1d311fa3c34b54f),
            ("above-marker", aux, 0x21a3dcdd48ed8a98),
        ];
        for (name, config, expected) in pinned {
            let (data, width, height) = render_overlay(&config).unwrap();
            assert_eq!((width, height), (300, 375), "{name}");
            assert_eq!(fnv1a(&data), expected, "{name}: classic pixels drifted");
        }
    }
}
