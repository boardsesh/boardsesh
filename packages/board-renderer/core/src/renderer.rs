use std::collections::HashMap;
use tiny_skia::{Color as SkiaColor, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

use crate::frames_parser::parse_frames;
use crate::types::{HoldData, HoldMarkerShape, HoldRenderStyle, RenderConfig};

fn marker_shape_path(shape: HoldMarkerShape, cx: f32, cy: f32, r: f32) -> Option<tiny_skia::Path> {
    match shape {
        HoldMarkerShape::Circle => PathBuilder::from_circle(cx, cy, r),
        HoldMarkerShape::TriangleUp => {
            let mut builder = PathBuilder::new();
            builder.move_to(cx, cy - r);
            builder.line_to(cx + r * 0.866, cy + r * 0.5);
            builder.line_to(cx - r * 0.866, cy + r * 0.5);
            builder.close();
            builder.finish()
        }
        HoldMarkerShape::TriangleDown => {
            let mut builder = PathBuilder::new();
            builder.move_to(cx - r * 0.866, cy - r * 0.5);
            builder.line_to(cx + r * 0.866, cy - r * 0.5);
            builder.line_to(cx, cy + r);
            builder.close();
            builder.finish()
        }
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

/// Render a transparent overlay with hold circles drawn on it.
/// Returns RGBA pixel data and dimensions (width, height).
pub fn render_overlay(config: &RenderConfig) -> Result<(Vec<u8>, u32, u32), String> {
    let output_width = config.output_width;
    let output_height =
        (output_width as f32 * config.board_height / config.board_width).round() as u32;

    if output_width == 0 || output_height == 0 {
        return Err("Output dimensions must be non-zero".into());
    }

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

    let mut paint = Paint::default();
    paint.anti_alias = true;

    let mut stroke_style = Stroke::default();
    stroke_style.width = stroke_width;

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

                let mut marker_stroke = Stroke::default();
                marker_stroke.width = (stroke_width * 0.45).max(2.0);
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
            },
        );
        hold_state_map.insert(
            43,
            HoldStateInfo {
                color: "#00FFFF".into(),
                render_style: Default::default(),
                shape: Default::default(),
            },
        );
        hold_state_map.insert(
            44,
            HoldStateInfo {
                color: "#FF00FF".into(),
                render_style: Default::default(),
                shape: Default::default(),
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
                },
                HoldData {
                    id: 2,
                    mirrored_hold_id: None,
                    cx: 500.0,
                    cy: 600.0,
                    r: 20.0,
                },
                HoldData {
                    id: 3,
                    mirrored_hold_id: None,
                    cx: 800.0,
                    cy: 900.0,
                    r: 20.0,
                },
            ],
            hold_state_map,
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
    fn test_render_above_marker_differs_from_circle_render() {
        let mut aux_config = test_config();
        aux_config.frames = "p1r46".into();
        aux_config.hold_state_map.insert(
            46,
            HoldStateInfo {
                color: "#FFE066".into(),
                render_style: HoldRenderStyle::AboveMarker,
                shape: Default::default(),
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
        let info: HoldStateInfo = serde_json::from_str(r##"{"color":"#00FF00","shape":"octagon"}"##).unwrap();
        assert_eq!(info.shape, HoldMarkerShape::Octagon);
    }

    #[test]
    fn test_unknown_shape_falls_back_instead_of_failing_parse() {
        // A newer JS bundle could send a shape this binary doesn't know; it must
        // deserialise to Unknown (rendered as a circle), not error the whole config.
        let info: HoldStateInfo =
            serde_json::from_str(r##"{"color":"#00FF00","shape":"hexagram-from-the-future"}"##).unwrap();
        assert_eq!(info.shape, HoldMarkerShape::Unknown);
        let data = render_single_shape(HoldMarkerShape::Unknown);
        assert!(data.chunks(4).any(|pixel| pixel[3] > 0));
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
            },
        );
        let (data, _, _) = render_overlay(&config).unwrap();
        data
    }
}
