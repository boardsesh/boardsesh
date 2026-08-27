//! A lit hold's silhouette in output pixels, and the numbers the glow reads
//! off it.

use tiny_skia::{Path, PathBuilder, Rect};

use crate::types::{Color, GlowTuning, HoldData, HoldRole};

pub struct LitHold {
    pub role: HoldRole,
    pub color: Color,
    /// Placement centre, output px.
    pub cx: f32,
    pub cy: f32,
    /// Placement radius, output px.
    pub r_px: f32,
    /// Output px per board unit — the 1.5 board-px floors are applied in board
    /// space and scaled, the way the spike drew them through the SVG viewBox.
    pub scale: f32,
    pub path: Path,
    /// `true` when the path is a traced silhouette, `false` for the circle
    /// fallback (no or malformed outline).
    pub traced: bool,
    /// Silhouette bbox centre, as an offset from the placement centre (px).
    pub centre_dx: f32,
    pub centre_dy: f32,
    /// Silhouette bbox extents (px). A circle reports `2r` for both.
    pub longest: f32,
    pub shortest: f32,
    pub silhouette_lightness: Option<f32>,
}

/// An outline is usable when it has at least three finite points.
pub fn valid_outline(outline: &[f32]) -> bool {
    outline.len() >= 6
        && outline.len().is_multiple_of(2)
        && outline.iter().all(|value| value.is_finite())
}

impl LitHold {
    pub fn new(
        hold: &HoldData,
        role: HoldRole,
        color: Color,
        scale_x: f32,
        scale_y: f32,
    ) -> Option<LitHold> {
        let cx = hold.cx * scale_x;
        let cy = hold.cy * scale_y;
        let r_px = hold.r * scale_x;
        if !(cx.is_finite() && cy.is_finite() && r_px.is_finite() && r_px > 0.0) {
            return None;
        }
        let base =
            |path: Path, traced: bool, centre: (f32, f32), longest: f32, shortest: f32| LitHold {
                role,
                color,
                cx,
                cy,
                r_px,
                scale: scale_x,
                path,
                traced,
                centre_dx: centre.0,
                centre_dy: centre.1,
                longest,
                shortest,
                silhouette_lightness: hold.silhouette_lightness.filter(|value| value.is_finite()),
            };

        if let Some(outline) = hold
            .outline
            .as_deref()
            .filter(|outline| valid_outline(outline))
        {
            let mut builder = PathBuilder::new();
            let (mut min_x, mut min_y, mut max_x, mut max_y) =
                (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for (index, pair) in outline.chunks_exact(2).enumerate() {
                let x = cx + pair[0] * r_px;
                let y = cy + pair[1] * r_px;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                if index == 0 {
                    builder.move_to(x, y);
                } else {
                    builder.line_to(x, y);
                }
            }
            builder.close();
            let width = max_x - min_x;
            let height = max_y - min_y;
            if let Some(path) = builder.finish().filter(|_| width > 0.0 && height > 0.0) {
                return Some(base(
                    path,
                    true,
                    ((min_x + max_x) / 2.0 - cx, (min_y + max_y) / 2.0 - cy),
                    width.max(height),
                    width.min(height),
                ));
            }
        }

        let circle = PathBuilder::from_circle(cx, cy, r_px)?;
        Some(base(circle, false, (0.0, 0.0), 2.0 * r_px, 2.0 * r_px))
    }

    /// How far past the silhouette edge the glow reaches, in output px.
    ///
    /// `boost` is the small-hold rule: a hold whose longest extent is under
    /// `size_floor_fraction × 2r` gets a bigger glow, not a second mark. The
    /// reach is then capped by the silhouette's shortest extent so a sliver
    /// stays an outline rather than becoming a disc with a chip in it.
    /// `extra_scale` is the user's shape-size multiplier.
    pub fn reach_px(&self, glow: &GlowTuning, extra_scale: f32) -> f32 {
        let max_boost = if glow.small_hold_max_boost.is_finite() {
            glow.small_hold_max_boost.max(1.0)
        } else {
            1.0
        };
        let boost = if self.traced {
            let size_floor = 2.0 * self.r_px * glow.size_floor_fraction;
            (size_floor / self.longest.max(1.0)).clamp(1.0, max_boost)
        } else {
            1.0
        };
        let spread =
            (glow.spread_fraction * self.r_px * boost).min(self.shortest * glow.hold_extent_cap);
        let reach = spread * glow.reach_scale * extra_scale;
        if reach.is_finite() {
            reach.max(0.0)
        } else {
            0.0
        }
    }

    pub fn bounds(&self) -> Rect {
        self.path.bounds()
    }
}
