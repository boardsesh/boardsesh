//! Everything in the Aura overlay that is not the glow: the veil, the
//! rejected-but-settable soft disc, the LED covers, the role fill and the
//! accessibility glyphs.

use tiny_skia::{
    BlendMode, Color as SkiaColor, FillRule, GradientStop, LineCap, LineJoin, Mask, Paint,
    PathBuilder, Pixmap, Point, RadialGradient, SpreadMode, Stroke, Transform,
};

use super::geometry::LitHold;
use crate::types::{
    Color, FillTuning, GlyphTuning, HoldData, HoldRole, LedBaseTuning, LedCover, Veil,
};

const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
};

/// A finite, strictly positive number — the guard every opacity and width
/// passes through so a NaN from a hostile config draws nothing.
fn positive(value: f32) -> bool {
    value.is_finite() && value > 0.0
}

fn alpha_byte(opacity: f32) -> u8 {
    (opacity.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn solid(paint: &mut Paint, color: Color, opacity: f32) {
    paint.set_color(SkiaColor::from_rgba8(
        color.r,
        color.g,
        color.b,
        alpha_byte(opacity),
    ));
}

/// Punch every lit silhouette out of whatever has been painted so far.
/// `Clear` is idempotent, so two overlapping silhouettes clear their overlap
/// once — an even-odd union path would paint it back in.
pub fn clear_silhouettes(pixmap: &mut Pixmap, lit: &[LitHold]) {
    let paint = Paint {
        anti_alias: true,
        blend_mode: BlendMode::Clear,
        ..Paint::default()
    };
    for hold in lit {
        pixmap.fill_path(
            &hold.path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

/// The veil: the whole overlay washed in the field colour, lit holes punched
/// out. Painted first, so it is a plain fill rather than a rect-minus-paths.
pub fn paint_veil(pixmap: &mut Pixmap, veil: &Veil, lit: &[LitHold]) {
    if !positive(veil.opacity) {
        return;
    }
    let Some(color) = Color::from_hex(&veil.color) else {
        return;
    };
    pixmap.fill(SkiaColor::from_rgba8(
        color.r,
        color.g,
        color.b,
        alpha_byte(veil.opacity),
    ));
    clear_silhouettes(pixmap, lit);
}

/// The rejected soft disc: the ring's footprint as a hint under the glow,
/// flat to 0.6r and gone at r, then cleared off the hold surface.
pub fn paint_soft_discs(pixmap: &mut Pixmap, lit: &[LitHold], opacity: f32) {
    if !positive(opacity) {
        return;
    }
    let opacity = opacity.min(1.0);
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    for hold in lit {
        let centre = Point::from_xy(hold.cx, hold.cy);
        let tint = |alpha: f32| {
            SkiaColor::from_rgba8(hold.color.r, hold.color.g, hold.color.b, alpha_byte(alpha))
        };
        let Some(shader) = RadialGradient::new(
            centre,
            centre,
            hold.r_px,
            vec![
                GradientStop::new(0.0, tint(opacity)),
                GradientStop::new(0.6, tint(opacity)),
                GradientStop::new(1.0, tint(0.0)),
            ],
            SpreadMode::Pad,
            Transform::identity(),
        ) else {
            continue;
        };
        let Some(disc) = PathBuilder::from_circle(hold.cx, hold.cy, hold.r_px) else {
            continue;
        };
        paint.shader = shader;
        pixmap.fill_path(
            &disc,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    clear_silhouettes(pixmap, lit);
}

/// A dark disc over every LED the board art paints bright — lit or not — so
/// the photograph's own pip never reads as a mark. Physical placements, so
/// mirroring never moves them.
pub fn paint_led_covers(
    pixmap: &mut Pixmap,
    holds: &[HoldData],
    scale_x: f32,
    scale_y: f32,
    cover: &LedCover,
) {
    let Some(color) = Color::from_hex(&cover.color) else {
        return;
    };
    if !positive(cover.opacity) {
        return;
    }
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    solid(&mut paint, color, cover.opacity);
    for hold in holds {
        let Some([dx, dy]) = hold.led else { continue };
        if !(dx.is_finite() && dy.is_finite() && hold.r > 0.0) {
            continue;
        }
        let cx = (hold.cx + dx * hold.r) * scale_x;
        let cy = (hold.cy + dy * hold.r) * scale_y;
        let radius = (cover.radius_fraction * hold.r).max(1.5) * scale_x;
        let Some(disc) = PathBuilder::from_circle(cx, cy, radius) else {
            continue;
        };
        pixmap.fill_path(
            &disc,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

fn silhouette_mask(mask: &mut Mask, hold: &LitHold) {
    mask.clear();
    mask.fill_path(&hold.path, FillRule::Winding, true, Transform::identity());
}

/// The role fill: lift dark art toward a common lightness (one-way), the role
/// colour at `opacity`, a saturated inner band clipped inside the silhouette,
/// and a thin white outer edge. `edge_scale` is the user's brush multiplier.
///
/// `interior_scale` dims the role colour on the holds that have an LED base
/// plate: there the plate ring carries the mark, and the body under it only has
/// to stay readable. Holds without a plate — every hold on every board that has
/// no `led_inner` table — never see it.
pub fn paint_fill(
    pixmap: &mut Pixmap,
    lit: &[LitHold],
    fill: &FillTuning,
    edge_scale: f32,
    interior_scale: f32,
) {
    let Some(mut inside) = Mask::new(pixmap.width(), pixmap.height()) else {
        return;
    };
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    let mut stroke = Stroke {
        line_join: LineJoin::Round,
        ..Stroke::default()
    };
    let target = fill.normalise_target;
    let interior_scale = if interior_scale.is_finite() {
        interior_scale.clamp(0.0, 1.0)
    } else {
        1.0
    };
    for hold in lit {
        if let Some(lightness) = hold
            .silhouette_lightness
            .filter(|lightness| *lightness < target)
        {
            let lift = ((target - lightness) / (1.0 - lightness).max(1e-3)).clamp(0.0, 0.9);
            if lift > 0.0 {
                solid(&mut paint, WHITE, lift);
                pixmap.fill_path(
                    &hold.path,
                    &paint,
                    FillRule::Winding,
                    Transform::identity(),
                    None,
                );
            }
        }
        let body_opacity = if hold.base_path.is_some() {
            fill.opacity * interior_scale
        } else {
            fill.opacity
        };
        solid(&mut paint, hold.color, body_opacity);
        pixmap.fill_path(
            &hold.path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );

        let band_width = fill.band_width_fraction * hold.r_px * 2.0 * edge_scale;
        if positive(band_width) {
            silhouette_mask(&mut inside, hold);
            stroke.width = band_width;
            solid(&mut paint, hold.color, 1.0);
            pixmap.stroke_path(
                &hold.path,
                &paint,
                &stroke,
                Transform::identity(),
                Some(&inside),
            );
        }

        let edge_width = fill.outer_edge_width_fraction * hold.r_px * edge_scale;
        if positive(edge_width) && positive(fill.outer_edge_opacity) {
            stroke.width = edge_width;
            solid(&mut paint, WHITE, fill.outer_edge_opacity);
            pixmap.stroke_path(&hold.path, &paint, &stroke, Transform::identity(), None);
        }
    }
}

/// The LED base plate: the ring between the silhouette and the hold proper,
/// lit in the role colour at close to full strength. This is the mark on a
/// board whose art has been annotated — the part a real LED shines through —
/// and the glow outside it comes off this same ring.
///
/// Even-odd, so the hold proper is a hole rather than a second lit patch.
/// Holds with no plate ring are skipped and keep whatever the fill and glow
/// already drew.
///
/// Clipped to the silhouette, always. `plate_ring_is_usable` already rejects a
/// ring that escapes the hold, but a silhouette is a traced polygon and is
/// routinely concave, so an even-odd fill over two rings must never be ABLE to
/// reach bare wall. The clip makes that structural rather than a question of
/// how good the geometry guard is.
pub fn paint_led_base(pixmap: &mut Pixmap, lit: &[LitHold], base: &LedBaseTuning) {
    if !positive(base.opacity) {
        return;
    }
    let Some(mut inside) = Mask::new(pixmap.width(), pixmap.height()) else {
        return;
    };
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    for hold in lit {
        let Some(plate) = &hold.base_path else {
            continue;
        };
        silhouette_mask(&mut inside, hold);
        solid(&mut paint, hold.color, base.opacity);
        pixmap.fill_path(
            plate,
            &paint,
            FillRule::EvenOdd,
            Transform::identity(),
            Some(&inside),
        );
    }
}

fn glyph_path(
    role: HoldRole,
    cx: f32,
    cy: f32,
    reach: f32,
    foot_ring_fraction: f32,
) -> Option<tiny_skia::Path> {
    let mut builder = PathBuilder::new();
    match role {
        HoldRole::Starting => {
            builder.move_to(cx - reach, cy);
            builder.line_to(cx + reach, cy);
        }
        HoldRole::Hand => {
            builder.move_to(cx, cy - reach);
            builder.line_to(cx, cy + reach);
        }
        HoldRole::Finish => {
            let diagonal = reach * std::f32::consts::FRAC_1_SQRT_2;
            builder.move_to(cx - diagonal, cy - diagonal);
            builder.line_to(cx + diagonal, cy + diagonal);
            builder.move_to(cx - diagonal, cy + diagonal);
            builder.line_to(cx + diagonal, cy - diagonal);
        }
        HoldRole::Foot => {
            return PathBuilder::from_circle(cx, cy, reach * foot_ring_fraction);
        }
        HoldRole::Unknown => return None,
    }
    builder.finish()
}

/// The accessibility glyphs: one line width per board, bars edge to edge
/// through the silhouette (clipped to it), FINISH an X so it cannot be read as
/// the START and HAND bars together, FOOT a ring. Two passes over the WHOLE
/// glyph — casing, then core — so the X's crossing never cuts a dark stripe
/// through its other diagonal. `line_scale` is the user's brush multiplier.
pub fn paint_glyphs(pixmap: &mut Pixmap, lit: &[LitHold], glyph: &GlyphTuning, line_scale: f32) {
    let (Some(core), Some(casing)) = (
        Color::from_hex(&glyph.core_color),
        Color::from_hex(&glyph.casing_color),
    ) else {
        return;
    };
    let Some(mut inside) = Mask::new(pixmap.width(), pixmap.height()) else {
        return;
    };
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    let mut stroke = Stroke {
        line_cap: LineCap::Butt,
        ..Stroke::default()
    };
    for hold in lit {
        let reach = if hold.traced {
            hold.r_px * glyph.reach_radii
        } else {
            hold.r_px
        };
        let Some(path) = glyph_path(
            hold.role,
            hold.cx + hold.centre_dx,
            hold.cy + hold.centre_dy,
            reach,
            glyph.foot_ring_reach_fraction,
        ) else {
            continue;
        };
        let radius_board = hold.r_px / hold.scale.max(f32::EPSILON);
        let line_width =
            (glyph.line_width_fraction * radius_board).max(1.5) * hold.scale * line_scale;
        if !positive(line_width) {
            continue;
        }
        // Clipped to the silhouette on traced holds AND to the circle on the
        // fallback, so a bar's end never pokes past the mark it labels.
        silhouette_mask(&mut inside, hold);
        let mask = Some(&inside);
        for (color, width_factor, opacity) in [
            (casing, glyph.casing_width_factor, glyph.casing_opacity),
            (core, 1.0, glyph.opacity),
        ] {
            if !(positive(opacity) && positive(width_factor)) {
                continue;
            }
            stroke.width = line_width * width_factor;
            solid(&mut paint, color, opacity);
            pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), mask);
        }
    }
}
