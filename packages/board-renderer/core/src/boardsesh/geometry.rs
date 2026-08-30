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
    /// The LED base plate ring — the silhouette with the hold proper punched
    /// out — as a two-subpath path to be filled EVEN-ODD. `None` on every hold
    /// whose art carries no usable `led_inner`, which is nearly all of them.
    pub base_path: Option<Path>,
}

/// An outline is usable when it has at least three finite points.
pub fn valid_outline(outline: &[f32]) -> bool {
    outline.len() >= 6
        && outline.len().is_multiple_of(2)
        && outline.iter().all(|value| value.is_finite())
}

/// Board-px bounds of a ring, as `(min_x, min_y, max_x, max_y)`.
type RingBounds = (f32, f32, f32, f32);

/// Trace one implicitly-closed `r`-relative ring into `builder` as its own
/// subpath, in output px, and report its bounds.
fn append_ring(builder: &mut PathBuilder, ring: &[f32], cx: f32, cy: f32, r_px: f32) -> RingBounds {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let (pairs, _) = ring.as_chunks::<2>();
    for (index, [ring_x, ring_y]) in pairs.iter().enumerate() {
        let x = cx + ring_x * r_px;
        let y = cy + ring_y * r_px;
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
    (min_x, min_y, max_x, max_y)
}

/// Is `inner` a plausible hold-proper boundary inside `outer`?
///
/// Cheap and deliberately loose — a bounding-box containment test, not a
/// polygon one. It is not there to grade a tracing, only to reject the ring
/// that would make an even-odd fill light pixels OUTSIDE the silhouette: an
/// inner ring that sits beside the hold rather than within it, or one as large
/// as the silhouette itself, leaving no plate.
fn inner_ring_is_usable(outer: RingBounds, inner: RingBounds) -> bool {
    let (outer_min_x, outer_min_y, outer_max_x, outer_max_y) = outer;
    let (inner_min_x, inner_min_y, inner_max_x, inner_max_y) = inner;
    let slack = 0.5;
    inner_max_x > inner_min_x
        && inner_max_y > inner_min_y
        && inner_min_x >= outer_min_x - slack
        && inner_min_y >= outer_min_y - slack
        && inner_max_x <= outer_max_x + slack
        && inner_max_y <= outer_max_y + slack
        && (inner_max_x - inner_min_x) * (inner_max_y - inner_min_y)
            < (outer_max_x - outer_min_x) * (outer_max_y - outer_min_y)
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
        let base = |path: Path,
                    traced: bool,
                    centre: (f32, f32),
                    longest: f32,
                    shortest: f32,
                    base_path: Option<Path>| LitHold {
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
            base_path,
        };

        if let Some(outline) = hold
            .outline
            .as_deref()
            .filter(|outline| valid_outline(outline))
        {
            let mut builder = PathBuilder::new();
            let bounds @ (min_x, min_y, max_x, max_y) =
                append_ring(&mut builder, outline, cx, cy, r_px);
            let width = max_x - min_x;
            let height = max_y - min_y;
            if let Some(path) = builder.finish().filter(|_| width > 0.0 && height > 0.0) {
                // The plate ring, when the art has one: the same outer ring
                // plus the hold proper as a second subpath, filled even-odd.
                // Built from its own builder so a rejected inner ring cannot
                // touch the silhouette path itself.
                let base_path = hold
                    .led_inner
                    .as_deref()
                    .filter(|inner| valid_outline(inner))
                    .and_then(|inner| {
                        let mut plate = PathBuilder::new();
                        append_ring(&mut plate, outline, cx, cy, r_px);
                        let inner_bounds = append_ring(&mut plate, inner, cx, cy, r_px);
                        plate
                            .finish()
                            .filter(|_| inner_ring_is_usable(bounds, inner_bounds))
                    });
                return Some(base(
                    path,
                    true,
                    ((min_x + max_x) / 2.0 - cx, (min_y + max_y) / 2.0 - cy),
                    width.max(height),
                    width.min(height),
                    base_path,
                ));
            }
        }

        // No traced silhouette, so no plate either: a ring at the placement
        // radius has no inside and no outside to tell apart.
        let circle = PathBuilder::from_circle(cx, cy, r_px)?;
        Some(base(
            circle,
            false,
            (0.0, 0.0),
            2.0 * r_px,
            2.0 * r_px,
            None,
        ))
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
