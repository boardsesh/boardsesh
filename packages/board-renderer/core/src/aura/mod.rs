// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

//! The Aura render mode (issue #2202): veil + outward glow on each lit
//! hold's traced silhouette, with the fill, LED covers and role glyphs the
//! design passes settled on.
//!
//! Layer order, bottom to top: veil → soft disc (off by default) → LED covers
//! → glow → fill → LED base plate → glyphs → classic above-markers for
//! auxiliary roles. The classic renderer is untouched; `render_overlay`
//! dispatches here on `render_mode: "aura"`.
//!
//! The LED base plate layer only draws on holds whose art has a traced
//! `led_inner` ring, which today means a hand-annotated one. Everywhere else
//! the drawing is exactly what it was before that field existed.
//!
//! What the classic knobs mean here: `shape_size_multiplier` scales the glow's
//! reach, `stroke_width_multiplier` scales the fill's edge bands and the glyph
//! line width, and `hold_state_map[].shape` is ignored — the silhouette is the
//! shape, and the glyphs are the accessibility channel that replaces it.

mod geometry;
mod glow;
mod marks;
#[cfg(test)]
mod tests;

use std::collections::HashMap;

use tiny_skia::{Color as SkiaColor, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

use crate::frames_parser::parse_frames;
use crate::types::{Color, GlyphMode, HoldData, HoldRenderStyle, MarkStyle, RenderConfig};
use geometry::LitHold;
use glow::{FalloffLut, falloff_stops, paint_glow};
use marks::{
    paint_fill, paint_glyphs, paint_led_base, paint_led_covers, paint_soft_discs, paint_veil,
};

fn clamp_multiplier(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

/// Which mark the config asks for, with the surface default when unset.
pub fn effective_mark_style(config: &RenderConfig) -> MarkStyle {
    match config.mark_style {
        Some(MarkStyle::Unknown) | None => {
            if config.thumbnail {
                MarkStyle::GlowFill
            } else {
                MarkStyle::Glow
            }
        }
        Some(style) => style,
    }
}

pub fn render(config: &RenderConfig) -> Result<(Vec<u8>, u32, u32), String> {
    let (output_width, output_height) = crate::renderer::output_size(config)?;
    let mut pixmap = Pixmap::new(output_width, output_height).ok_or("Failed to create pixmap")?;
    let scale_x = output_width as f32 / config.board_width;
    let scale_y = output_height as f32 / config.board_height;

    let parsed_holds = parse_frames(&config.frames, &config.hold_state_map);
    let mut holds_by_id: HashMap<u32, &HoldData> = HashMap::with_capacity(config.holds.len());
    for hold in &config.holds {
        holds_by_id.insert(hold.id, hold);
    }

    let stroke_width_multiplier = clamp_multiplier(config.stroke_width_multiplier);
    let shape_size_multiplier = clamp_multiplier(config.shape_size_multiplier);

    let mut lit: Vec<LitHold> = Vec::with_capacity(parsed_holds.len());
    let mut lit_hold_ids: std::collections::HashSet<u32> =
        std::collections::HashSet::with_capacity(parsed_holds.len());
    let mut above_markers: Vec<(&HoldData, Color)> = Vec::new();
    for parsed in &parsed_holds {
        let Some(hold) = holds_by_id.get(&parsed.hold_id).copied() else {
            continue;
        };
        let render_hold = if config.mirrored {
            hold.mirrored_hold_id
                .and_then(|mirrored_id| holds_by_id.get(&mirrored_id).copied())
                .unwrap_or(hold)
        } else {
            hold
        };
        match parsed.render_style {
            HoldRenderStyle::AboveMarker => above_markers.push((render_hold, parsed.color)),
            HoldRenderStyle::Circle => {
                if let Some(lit_hold) =
                    LitHold::new(render_hold, parsed.role, parsed.color, scale_x, scale_y)
                {
                    lit.push(lit_hold);
                    lit_hold_ids.insert(render_hold.id);
                }
            }
        }
    }

    let mark_style = effective_mark_style(config);
    let draws_glow = matches!(mark_style, MarkStyle::Glow | MarkStyle::GlowFill);
    let draws_fill = matches!(mark_style, MarkStyle::Fill | MarkStyle::GlowFill);
    // One switch for the whole plate treatment, read by all three consumers.
    // Without it `opacity: 0` stopped the rim being painted but still dimmed
    // the fill under it and still measured the glow off it — a hold left 40%
    // darker with nothing to show for it, which is not what "off" means.
    // `mark-style: none` asks for no mark at all, plate included.
    let plate_opacity = config.led_base.opacity;
    let draws_plate =
        plate_opacity.is_finite() && plate_opacity > 0.0 && mark_style != MarkStyle::NoMark;

    if let Some(veil) = &config.veil {
        paint_veil(&mut pixmap, veil, &lit);
    }
    if draws_glow && config.glow.disc_opacity > 0.0 {
        paint_soft_discs(&mut pixmap, &lit, config.glow.disc_opacity);
    }
    if let Some(cover) = &config.led_cover {
        paint_led_covers(&mut pixmap, &config.holds, scale_x, scale_y, cover);
    }
    if draws_glow {
        let lut = FalloffLut::from_stops(&falloff_stops(
            config.glow_falloff,
            config.glow.plateau_share,
        ));
        let reaches: Vec<f32> = lit
            .iter()
            .map(|hold| hold.reach_px(&config.glow, shape_size_multiplier))
            .collect();
        // The union of every unlit traced silhouette, built only when the
        // light-spill effect will read it.
        let spill_path = if config.glow.spill_boost > 0.0 {
            let mut spill_builder = PathBuilder::new();
            geometry::append_unlit_silhouettes(
                &mut spill_builder,
                &config.holds,
                &lit_hold_ids,
                scale_x,
                scale_y,
            );
            spill_builder.finish()
        } else {
            None
        };
        paint_glow(
            &mut pixmap,
            &lit,
            &reaches,
            &lut,
            draws_plate && config.led_base.glow_from_base,
            &config.glow,
            spill_path.as_ref(),
        );
    }
    if draws_fill {
        let interior_scale = if draws_plate {
            config.led_base.interior_fill_scale
        } else {
            1.0
        };
        paint_fill(
            &mut pixmap,
            &lit,
            &config.fill,
            stroke_width_multiplier,
            interior_scale,
        );
    }
    // The LED base plate goes on last of the silhouette layers: it is the mark
    // on an annotated hold, so it sits over the fill it dimmed.
    if draws_plate {
        paint_led_base(&mut pixmap, &lit, &config.led_base);
    }
    if config.glyphs == GlyphMode::Role {
        paint_glyphs(&mut pixmap, &lit, &config.glyph, stroke_width_multiplier);
    }

    // Auxiliary roles (Woods / MoonBoard `above-marker`) keep the classic pip
    // above the hold: they are annotations, not lit silhouettes.
    if !above_markers.is_empty() {
        let stroke_width =
            (if config.thumbnail { 8.0 } else { 6.0 }) * scale_x * stroke_width_multiplier;
        let mut paint = Paint {
            anti_alias: true,
            ..Paint::default()
        };
        let marker_stroke = Stroke {
            width: (stroke_width * 0.45).max(2.0),
            ..Stroke::default()
        };
        for (hold, color) in above_markers {
            let cx = hold.cx * scale_x;
            let cy = hold.cy * scale_y;
            let r = hold.r * scale_x;
            let marker_radius = (r * if config.thumbnail { 0.62 } else { 0.48 }).max(2.0);
            let marker_cy = cy - (r * if config.thumbnail { 1.28 } else { 1.15 });
            let Some(path) = PathBuilder::from_circle(cx, marker_cy, marker_radius) else {
                continue;
            };
            paint.set_color(SkiaColor::from_rgba8(color.r, color.g, color.b, 255));
            pixmap.fill_path(
                &path,
                &paint,
                FillRule::Winding,
                Transform::identity(),
                None,
            );
            pixmap.stroke_path(&path, &paint, &marker_stroke, Transform::identity(), None);
        }
    }

    Ok((pixmap.data().to_vec(), output_width, output_height))
}
