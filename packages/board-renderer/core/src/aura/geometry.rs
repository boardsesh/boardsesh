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

/// Bounds of a ring in ITS OWN units, as `(min_x, min_y, max_x, max_y)`.
type RingBounds = (f32, f32, f32, f32);

/// Append every unlit traced silhouette to `builder` — the shapes the glow's
/// light-spill effect brightens. Ring-fallback holds are skipped on purpose: a
/// circle at the placement radius would tint bare wall as if it were a hold.
pub(super) fn append_unlit_silhouettes(
    builder: &mut PathBuilder,
    holds: &[HoldData],
    lit_ids: &std::collections::HashSet<u32>,
    scale_x: f32,
    scale_y: f32,
) {
    for hold in holds {
        if lit_ids.contains(&hold.id) {
            continue;
        }
        let Some(outline) = hold
            .outline
            .as_deref()
            .filter(|outline| valid_outline(outline))
        else {
            continue;
        };
        let cx = hold.cx * scale_x;
        let cy = hold.cy * scale_y;
        let r_px = hold.r * scale_x;
        if !(cx.is_finite() && cy.is_finite() && r_px.is_finite() && r_px > 0.0) {
            continue;
        }
        append_ring(builder, outline, cx, cy, r_px);
    }
}

/// Trace one implicitly-closed `r`-relative ring into `builder` as its own
/// subpath, in output px, and report its bounds in output px.
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

/// A ring's bounds in radius units — the units the shard stores.
fn ring_bounds(ring: &[f32]) -> RingBounds {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let (pairs, _) = ring.as_chunks::<2>();
    for [x, y] in pairs {
        min_x = min_x.min(*x);
        min_y = min_y.min(*y);
        max_x = max_x.max(*x);
        max_y = max_y.max(*y);
    }
    (min_x, min_y, max_x, max_y)
}

/// Shoelace area of an implicitly-closed ring, in radius units squared.
/// Unsigned, so winding direction does not matter.
fn ring_area(ring: &[f32]) -> f32 {
    let (pairs, _) = ring.as_chunks::<2>();
    let mut twice_area = 0.0;
    for (index, [x, y]) in pairs.iter().enumerate() {
        let [next_x, next_y] = pairs[(index + 1) % pairs.len()];
        twice_area += x * next_y - next_x * y;
    }
    (twice_area / 2.0).abs()
}

/// Perimeter of an implicitly-closed ring, in radius units.
fn ring_perimeter(ring: &[f32]) -> f32 {
    let (pairs, _) = ring.as_chunks::<2>();
    let mut perimeter = 0.0;
    for (index, [x, y]) in pairs.iter().enumerate() {
        let [next_x, next_y] = pairs[(index + 1) % pairs.len()];
        perimeter += ((next_x - x).powi(2) + (next_y - y).powi(2)).sqrt();
    }
    perimeter
}

/// Crossing-number point-in-polygon against an implicitly-closed ring.
fn point_in_ring(ring: &[f32], point_x: f32, point_y: f32) -> bool {
    let (pairs, _) = ring.as_chunks::<2>();
    let mut inside = false;
    for (index, [x, y]) in pairs.iter().enumerate() {
        let [next_x, next_y] = pairs[(index + 1) % pairs.len()];
        if (*y > point_y) != (next_y > point_y) {
            let crossing_x = (next_x - x) * (point_y - y) / (next_y - y) + x;
            if point_x < crossing_x {
                inside = !inside;
            }
        }
    }
    inside
}

/// Squared distance from a point to a line segment.
fn distance_to_segment_squared(
    point_x: f32,
    point_y: f32,
    from_x: f32,
    from_y: f32,
    to_x: f32,
    to_y: f32,
) -> f32 {
    let run = to_x - from_x;
    let rise = to_y - from_y;
    let length_squared = run * run + rise * rise;
    let along = if length_squared <= 0.0 {
        0.0
    } else {
        (((point_x - from_x) * run + (point_y - from_y) * rise) / length_squared).clamp(0.0, 1.0)
    };
    let nearest_x = from_x + along * run;
    let nearest_y = from_y + along * rise;
    (point_x - nearest_x).powi(2) + (point_y - nearest_y).powi(2)
}

/// Is the point inside `ring`, or on its edge to within `tolerance`?
///
/// The tolerance is the difference between "must not escape the silhouette"
/// and "must not touch it". A plate that stops short of the rim on one side —
/// which is the whole reason the glow is measured off the plate rather than
/// the silhouette — has its inner boundary running ALONG the silhouette edge
/// there, and a strict inside-test rejects exactly the shape the feature is
/// for. Crossing-number is undefined on the boundary anyway.
fn point_within_ring(ring: &[f32], point_x: f32, point_y: f32, tolerance: f32) -> bool {
    if point_in_ring(ring, point_x, point_y) {
        return true;
    }
    let tolerance_squared = tolerance * tolerance;
    let (pairs, _) = ring.as_chunks::<2>();
    pairs.iter().enumerate().any(|(index, [x, y])| {
        let [next_x, next_y] = pairs[(index + 1) % pairs.len()];
        distance_to_segment_squared(point_x, point_y, *x, *y, next_x, next_y) <= tolerance_squared
    })
}

/// The narrowest plate a renderer will draw, in output px. Below this the ring
/// is not a rim at this size — it is a hairline that rasterises to nothing,
/// and accepting it would dim the hold body under a plate nobody can see.
const MIN_PLATE_WIDTH_PX: f32 = 1.0;

/// Is `inner` a usable hold-proper boundary inside `outer`, at this size?
///
/// Three questions, all asked in RADIUS units — the units the ring is stored
/// in — so the same hold is plated or not plated at every zoom, rather than
/// passing at native width and failing on a 200 px thumbnail:
///
/// 1. Does `inner`'s box sit inside `outer`'s? Cheap, and rejects the ring
///    traced against the wrong placement outright.
/// 2. Is every one of `inner`'s vertices inside `outer` itself (or on its edge
///    — see `point_within_ring`)? A silhouette is routinely concave — a hook or
///    a C — and its BOX contains bare wall, so a box test alone accepts a ring
///    sitting in the hollow. Even-odd over two disjoint rings then fills that
///    hollow: wall, painted the role colour.
/// 3. Is the plate wide enough to see? Mean band width is plate area over
///    silhouette perimeter, scaled to output px. A ring 0.005r inside the edge
///    is a legal polygon and a 0.1 px band.
///
/// Failing any of them is not an error: the hold lights whole, exactly as it
/// did before the field existed.
fn plate_ring_is_usable(outer: &[f32], inner: &[f32], r_px: f32) -> bool {
    let (outer_min_x, outer_min_y, outer_max_x, outer_max_y) = ring_bounds(outer);
    let (inner_min_x, inner_min_y, inner_max_x, inner_max_y) = ring_bounds(inner);
    // A hundredth of a placement radius: room for the shard's 4-decimal
    // rounding, far below any real plate.
    let slack = 0.01;
    let box_fits = inner_max_x > inner_min_x
        && inner_max_y > inner_min_y
        && inner_min_x >= outer_min_x - slack
        && inner_min_y >= outer_min_y - slack
        && inner_max_x <= outer_max_x + slack
        && inner_max_y <= outer_max_y + slack;
    if !box_fits {
        return false;
    }

    let (inner_pairs, _) = inner.as_chunks::<2>();
    if !inner_pairs
        .iter()
        .all(|[x, y]| point_within_ring(outer, *x, *y, slack))
    {
        return false;
    }

    let plate_area = ring_area(outer) - ring_area(inner);
    let perimeter = ring_perimeter(outer);
    if !(plate_area > 0.0 && perimeter > 0.0) {
        return false;
    }
    plate_area / perimeter * r_px >= MIN_PLATE_WIDTH_PX
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
            let (min_x, min_y, max_x, max_y) = append_ring(&mut builder, outline, cx, cy, r_px);
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
                    .filter(|inner| {
                        valid_outline(inner) && plate_ring_is_usable(outline, inner, r_px)
                    })
                    .and_then(|inner| {
                        let mut plate = PathBuilder::new();
                        append_ring(&mut plate, outline, cx, cy, r_px);
                        append_ring(&mut plate, inner, cx, cy, r_px);
                        plate.finish()
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
