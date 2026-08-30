//! The outward glow: alpha = falloff(distance outside the silhouette / reach),
//! in the colour of the nearest lit hold, zero on the hold itself.
//!
//! Drawn from labelled distance fields rather than the spike's concentric
//! strokes: exact curve at every pixel, the hard inner edge (the treatment), a
//! per-hold reach, and a midline split between neighbouring glows — the
//! nearest-silhouette partition — with no clip paths.

use tiny_skia::{FillRule, Mask, Pixmap, Transform};

use super::geometry::LitHold;
use crate::edt::{NO_DISTANCE, NO_SITE, labelled_edt};
use crate::types::{Color, GlowFalloff};

/// Variant A: cumulative alpha over the fraction of the reach.
pub const SOFT_STOPS: [(f32, f32); 5] = [
    (0.0, 1.0),
    (0.15, 0.9),
    (0.4, 0.42),
    (0.7, 0.13),
    (1.0, 0.0),
];

/// The stops for a falloff. The plateau holds ~full alpha over the inner
/// `plateau_share` of the reach (0.4 reproduces the spike's
/// `[[0,1],[0.4,0.97],[0.6,0.6],[0.8,0.22],[1,0]]`), then fades in three steps.
pub fn falloff_stops(falloff: GlowFalloff, plateau_share: f32) -> Vec<(f32, f32)> {
    match falloff {
        GlowFalloff::Plateau => {
            let share = if plateau_share.is_finite() {
                plateau_share.clamp(0.05, 0.9)
            } else {
                0.4
            };
            let step = (1.0 - share) / 3.0;
            vec![
                (0.0, 1.0),
                (share, 0.97),
                (share + step, 0.6),
                (share + 2.0 * step, 0.22),
                (1.0, 0.0),
            ]
        }
        GlowFalloff::Soft | GlowFalloff::Unknown => SOFT_STOPS.to_vec(),
    }
}

fn interpolate(stops: &[(f32, f32)], fraction: f32) -> f32 {
    let Some(first) = stops.first() else {
        return 0.0;
    };
    if fraction <= first.0 {
        return first.1;
    }
    for window in stops.windows(2) {
        let (previous_at, previous_alpha) = window[0];
        let (next_at, next_alpha) = window[1];
        if fraction > next_at {
            continue;
        }
        let span = next_at - previous_at;
        let position = if span <= 0.0 {
            0.0
        } else {
            (fraction - previous_at) / span
        };
        return previous_alpha + (next_alpha - previous_alpha) * position;
    }
    stops[stops.len() - 1].1
}

/// The falloff sampled at 257 points so the per-pixel loop never walks the
/// stops table.
pub struct FalloffLut {
    table: [f32; 257],
}

impl FalloffLut {
    pub fn from_stops(stops: &[(f32, f32)]) -> Self {
        let mut table = [0.0f32; 257];
        for (index, slot) in table.iter_mut().enumerate() {
            *slot = interpolate(stops, index as f32 / 256.0).clamp(0.0, 1.0);
        }
        Self { table }
    }

    pub fn at(&self, fraction: f32) -> f32 {
        if fraction.is_nan() || fraction <= 0.0 {
            return self.table[0];
        }
        if fraction >= 1.0 {
            return self.table[256];
        }
        let position = fraction * 256.0;
        let index = position.floor() as usize;
        let remainder = position - index as f32;
        self.table[index] + (self.table[index + 1] - self.table[index]) * remainder
    }
}

/// Source-over of a straight colour at `alpha` onto a premultiplied RGBA8 pixel.
pub fn blend_premultiplied(pixel: &mut [u8], color: Color, alpha: f32) {
    let alpha = alpha.clamp(0.0, 1.0);
    let keep = 1.0 - alpha;
    let mix = |source: u8, destination: u8| -> u8 {
        (source as f32 * alpha + destination as f32 * keep)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    pixel[0] = mix(color.r, pixel[0]);
    pixel[1] = mix(color.g, pixel[1]);
    pixel[2] = mix(color.b, pixel[2]);
    pixel[3] = mix(255, pixel[3]);
}

/// Paint every lit hold's glow. `reaches[i]` is `lit[i]`'s reach in px.
///
/// `from_base` measures the field from each hold's LED base plate ring instead
/// of its whole silhouette, so the glow reads as coming off the lit rim. Where
/// the plate reaches the silhouette edge — the usual shape, a rim all the way
/// round — the nearest site to any outside pixel is the same pixel either way
/// and the output is identical; where it does not, the glow correctly fades.
/// Coverage (which keeps glow off the hold surface) is always the full
/// silhouette, and a plate too thin to own a single pixel falls back to it.
///
/// The distance field is computed per hold over its own silhouette box
/// dilated by its reach — the only pixels its glow can touch — and merged by
/// nearest distance, which is the same nearest-silhouette partition a single
/// board-wide transform would give at a tenth of the pixels: seventeen lit
/// holds on a phone-size board cost ~170k transformed pixels, not 1.8 M.
pub fn paint_glow(
    pixmap: &mut Pixmap,
    lit: &[LitHold],
    reaches: &[f32],
    lut: &FalloffLut,
    from_base: bool,
) {
    debug_assert_eq!(lit.len(), reaches.len());
    if lit.is_empty() {
        return;
    }
    let width = pixmap.width() as usize;
    let height = pixmap.height() as usize;
    let max_reach = reaches.iter().copied().fold(0.0f32, f32::max);
    if !max_reach.is_finite() || max_reach <= 0.0 {
        return;
    }

    // Region of interest: every lit silhouette, dilated by the widest reach.
    let mut left = f32::MAX;
    let mut top = f32::MAX;
    let mut right = f32::MIN;
    let mut bottom = f32::MIN;
    for hold in lit {
        let bounds = hold.bounds();
        left = left.min(bounds.left());
        top = top.min(bounds.top());
        right = right.max(bounds.right());
        bottom = bottom.max(bounds.bottom());
    }
    let pad = max_reach.ceil() + 2.0;
    let roi_x0 = (left - pad).floor().clamp(0.0, width as f32) as usize;
    let roi_y0 = (top - pad).floor().clamp(0.0, height as f32) as usize;
    let roi_x1 = (right + pad).ceil().clamp(0.0, width as f32) as usize;
    let roi_y1 = (bottom + pad).ceil().clamp(0.0, height as f32) as usize;
    if roi_x1 <= roi_x0 || roi_y1 <= roi_y0 {
        return;
    }
    let roi_width = roi_x1 - roi_x0;
    let roi_height = roi_y1 - roi_y0;

    // Per pixel over the ROI: anti-aliased union coverage of every lit
    // silhouette (glow alpha is scaled by 1 − coverage, so no glow ever paints
    // a hold surface), the nearest silhouette's squared distance and its label.
    let mut coverage = vec![0u8; roi_width * roi_height];
    let mut best_dist2 = vec![NO_DISTANCE; roi_width * roi_height];
    let mut best_label = vec![NO_SITE; roi_width * roi_height];

    // Every hold's box is dilated by the WIDEST reach, not its own: a pixel
    // nearer to a short-reach hold than to a long-reach one must still find the
    // short-reach hold in the merge (and get nothing, since it is beyond that
    // hold's reach) rather than the long-reach hold's glow. With equal reaches
    // — the common case, one placement radius per board — the boxes are the
    // same size either way.
    let dilate = max_reach.ceil() + 2.0;
    for (index, hold) in lit.iter().enumerate() {
        let reach = reaches[index].max(0.0);
        let bounds = hold.bounds();
        let box_x0 = (bounds.left() - dilate)
            .floor()
            .clamp(roi_x0 as f32, roi_x1 as f32) as usize;
        let box_y0 = (bounds.top() - dilate)
            .floor()
            .clamp(roi_y0 as f32, roi_y1 as f32) as usize;
        let box_x1 = (bounds.right() + dilate)
            .ceil()
            .clamp(roi_x0 as f32, roi_x1 as f32) as usize;
        let box_y1 = (bounds.bottom() + dilate)
            .ceil()
            .clamp(roi_y0 as f32, roi_y1 as f32) as usize;
        if box_x1 <= box_x0 || box_y1 <= box_y0 {
            continue;
        }
        let box_width = box_x1 - box_x0;
        let box_height = box_y1 - box_y0;
        let Some(mut mask) = Mask::new(box_width as u32, box_height as u32) else {
            continue;
        };
        mask.fill_path(
            &hold.path,
            FillRule::Winding,
            true,
            Transform::from_translate(-(box_x0 as f32), -(box_y0 as f32)),
        );
        for y in 0..box_height {
            for x in 0..box_width {
                let alpha = mask.data()[y * box_width + x];
                if alpha == 0 {
                    continue;
                }
                let roi_index = (box_y0 + y - roi_y0) * roi_width + (box_x0 + x - roi_x0);
                if alpha > coverage[roi_index] {
                    coverage[roi_index] = alpha;
                }
            }
        }

        // Sites: the plate ring where there is one, the silhouette otherwise.
        // The plate is rasterised into its own mask because the coverage pass
        // above needs the silhouette's alpha, not the ring's.
        let plate_mask = hold
            .base_path
            .as_ref()
            .filter(|_| from_base)
            .and_then(|plate| {
                let mut plate_mask = Mask::new(box_width as u32, box_height as u32)?;
                plate_mask.fill_path(
                    plate,
                    FillRule::EvenOdd,
                    true,
                    Transform::from_translate(-(box_x0 as f32), -(box_y0 as f32)),
                );
                Some(plate_mask)
            });
        let mut sites = vec![NO_SITE; box_width * box_height];
        let mut any_site = false;
        for source in [plate_mask.as_ref(), Some(&mask)] {
            let Some(source) = source else { continue };
            for (site, alpha) in sites.iter_mut().zip(source.data()) {
                if *alpha >= 128 {
                    *site = 1;
                    any_site = true;
                }
            }
            // A plate too thin to claim a single pixel would erase the hold's
            // glow entirely; fall through to the silhouette instead.
            if any_site {
                break;
            }
        }
        // Coverage is recorded for every hold; only the first 65 535 can label a
        // pixel, which no climb approaches.
        if !any_site || reach <= 0.0 || index >= u16::MAX as usize {
            continue;
        }
        let field = labelled_edt(box_width, box_height, &sites);
        let label = (index + 1) as u16;
        for y in 0..box_height {
            for x in 0..box_width {
                let dist2 = field.dist2[y * box_width + x];
                if dist2 == NO_DISTANCE {
                    continue;
                }
                let roi_index = (box_y0 + y - roi_y0) * roi_width + (box_x0 + x - roi_x0);
                if dist2 < best_dist2[roi_index] {
                    best_dist2[roi_index] = dist2;
                    best_label[roi_index] = label;
                }
            }
        }
    }

    let stride = width * 4;
    let data = pixmap.data_mut();
    for y in 0..roi_height {
        let row = y * roi_width;
        for x in 0..roi_width {
            let roi_index = row + x;
            let label = best_label[roi_index];
            if label == NO_SITE {
                continue;
            }
            let hold_index = label as usize - 1;
            let reach = reaches[hold_index];
            let dist2 = best_dist2[roi_index];
            // Pixel centres: the nearest site pixel's centre sits half a pixel
            // inside the edge, so the edge itself is d = 0.
            let distance = ((dist2 as f32).sqrt() - 0.5).max(0.0);
            let fraction = distance / reach;
            if fraction >= 1.0 {
                continue;
            }
            let alpha = lut.at(fraction) * (1.0 - coverage[roi_index] as f32 / 255.0);
            if alpha <= 0.002 {
                continue;
            }
            let offset = (roi_y0 + y) * stride + (roi_x0 + x) * 4;
            blend_premultiplied(&mut data[offset..offset + 4], lit[hold_index].color, alpha);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_lut_follows_the_stops() {
        let lut = FalloffLut::from_stops(&SOFT_STOPS);
        assert!((lut.at(0.0) - 1.0).abs() < 1e-6);
        assert!(
            (lut.at(0.15) - 0.9).abs() < 5e-3,
            "257-entry table straddles the knot"
        );
        assert!((lut.at(0.4) - 0.42).abs() < 5e-3);
        assert!((lut.at(0.7) - 0.13).abs() < 5e-3);
        assert!(lut.at(1.0).abs() < 1e-6);
        assert!(lut.at(1.5).abs() < 1e-6);
    }

    #[test]
    fn plateau_share_places_the_shoulder() {
        let stops = falloff_stops(GlowFalloff::Plateau, 0.4);
        assert_eq!(stops[1], (0.4, 0.97));
        assert!((stops[2].0 - 0.6).abs() < 1e-6);
        assert!((stops[3].0 - 0.8).abs() < 1e-6);
        let wide = falloff_stops(GlowFalloff::Plateau, 0.7);
        assert_eq!(wide[1].0, 0.7);
        let clamped = falloff_stops(GlowFalloff::Plateau, 5.0);
        assert_eq!(clamped[1].0, 0.9);
        assert_eq!(
            falloff_stops(GlowFalloff::Unknown, 0.4),
            SOFT_STOPS.to_vec()
        );
    }

    #[test]
    fn premultiplied_blend_is_source_over() {
        let mut pixel = [0u8, 0, 0, 0];
        blend_premultiplied(&mut pixel, Color { r: 255, g: 0, b: 0 }, 0.5);
        assert_eq!(pixel, [128, 0, 0, 128]);
        blend_premultiplied(&mut pixel, Color { r: 0, g: 255, b: 0 }, 1.0);
        assert_eq!(pixel, [0, 255, 0, 255]);
    }
}
