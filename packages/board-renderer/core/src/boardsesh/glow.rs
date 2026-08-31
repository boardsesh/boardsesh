//! The outward glow: alpha = falloff(distance outside the silhouette / reach),
//! in the colour of the nearest lit hold, zero on the hold itself.
//!
//! Drawn from labelled distance fields rather than the spike's concentric
//! strokes: exact curve at every pixel, the hard inner edge (the treatment), a
//! per-hold reach, and a midline split between neighbouring glows — the
//! nearest-silhouette partition — with no clip paths.
//!
//! On top of that base field sit the advanced-glow effects (all off by
//! default, every one gated so the neutral config renders byte-identically):
//! gamma-shaped falloff, alpha dither, a two-tone white core / deep fringe,
//! a neon rim hugging the silhouette, smooth-min merging of same-colour
//! neighbours, a colour crossfade across different-colour seams, and light
//! spill over unlit traced silhouettes.

use tiny_skia::{FillRule, Mask, Path, Pixmap, Transform};

use super::geometry::LitHold;
use crate::edt::{NO_DISTANCE, NO_SITE, labelled_edt};
use crate::types::{Color, GlowFalloff, GlowTuning};

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

const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
};

fn lerp_color(from: Color, to: Color, t: f32) -> Color {
    let t = t.clamp(0.0, 1.0);
    let mix = |a: u8, b: u8| -> u8 { (a as f32 + (b as f32 - a as f32) * t).round() as u8 };
    Color {
        r: mix(from.r, to.r),
        g: mix(from.g, to.g),
        b: mix(from.b, to.b),
    }
}

/// The hue-preserving dark the two-tone fringe deepens toward. Rounds like
/// `lerp_color`, which it composes with in the fringe path.
fn deepened(color: Color) -> Color {
    Color {
        r: (color.r as f32 * 0.35).round() as u8,
        g: (color.g as f32 * 0.35).round() as u8,
        b: (color.b as f32 * 0.35).round() as u8,
    }
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge1 <= edge0 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Interleaved gradient noise (Jimenez 2014): cheap, stateless, structured
/// enough to break banding without reading as grain.
fn interleaved_gradient_noise(x: usize, y: usize) -> f32 {
    let value = 0.067_110_56_f32 * x as f32 + 0.005_837_15_f32 * y as f32;
    (52.982_918 * value.fract()).fract()
}

fn clamp_or(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

/// The advanced-glow knobs, sanitised once per render. At the defaults every
/// gate is off and the paint loop is exactly the base renderer's.
struct GlowStyle {
    gamma: f32,
    apply_gamma: bool,
    dither: f32,
    core_whiten: f32,
    core_share: f32,
    fringe_deepen: f32,
    two_tone: bool,
    rim_width_fraction: f32,
    rim_opacity: f32,
    rim_whiten: f32,
    rim: bool,
    merge_softness: f32,
    seam_blend: f32,
    seam_max_mix: f32,
    track_second: bool,
    spill_boost: f32,
}

impl GlowStyle {
    fn from_tuning(tuning: &GlowTuning) -> Self {
        let gamma = clamp_or(tuning.falloff_gamma, 0.25, 4.0, 1.0);
        let dither = clamp_or(tuning.dither, 0.0, 0.25, 0.0);
        let core_whiten = clamp_or(tuning.core_whiten, 0.0, 1.0, 0.0);
        let core_share = clamp_or(tuning.core_share, 0.02, 1.0, 0.25);
        let fringe_deepen = clamp_or(tuning.fringe_deepen, 0.0, 1.0, 0.0);
        let rim_width_fraction = clamp_or(tuning.rim_width_fraction, 0.0, 0.5, 0.0);
        let merge_softness = clamp_or(tuning.merge_softness, 0.0, 1.0, 0.0);
        let seam_blend = clamp_or(tuning.seam_blend_fraction, 0.0, 1.0, 0.0);
        let seam_max_mix = clamp_or(tuning.seam_max_mix, 0.0, 0.5, 0.5);
        Self {
            gamma,
            apply_gamma: (gamma - 1.0).abs() > 1e-3,
            dither,
            core_whiten,
            core_share,
            fringe_deepen,
            two_tone: core_whiten > 0.0 || fringe_deepen > 0.0,
            rim_width_fraction,
            rim_opacity: clamp_or(tuning.rim_opacity, 0.0, 1.0, 0.85),
            rim_whiten: clamp_or(tuning.rim_whiten, 0.0, 1.0, 0.65),
            rim: rim_width_fraction > 0.0,
            merge_softness,
            seam_blend,
            seam_max_mix,
            track_second: merge_softness > 0.0 || seam_blend > 0.0,
            spill_boost: clamp_or(tuning.spill_boost, 0.0, 4.0, 0.0),
        }
    }
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
/// `spill` is the union of every unlit traced silhouette, rasterised only when
/// `spill_boost` is on — the shapes the light spill brightens.
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
    tuning: &GlowTuning,
    spill: Option<&Path>,
) {
    debug_assert_eq!(lit.len(), reaches.len());
    if lit.is_empty() {
        return;
    }
    let style = GlowStyle::from_tuning(tuning);
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
    // The SECOND-nearest hold, tracked only when the merge or seam effect
    // needs it: same-colour pairs smooth-min their fields, different-colour
    // pairs crossfade across the bisector.
    let mut second_dist2 = if style.track_second {
        vec![NO_DISTANCE; roi_width * roi_height]
    } else {
        Vec::new()
    };
    let mut second_label = if style.track_second {
        vec![NO_SITE; roi_width * roi_height]
    } else {
        Vec::new()
    };

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
        let silhouette_alpha = mask.data();
        for y in 0..box_height {
            for x in 0..box_width {
                let alpha = silhouette_alpha[y * box_width + x];
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
        // above needs the silhouette's alpha, not the ring's — and it is
        // INTERSECTED with the silhouette, for the same reason the painted
        // plate is clipped to it: an even-odd fill over a ring the geometry
        // guard cannot fully vouch for must never be able to seed glow sites
        // out on bare wall.
        //
        // No hairline fallback here: `plate_ring_is_usable` rejects a plate
        // too narrow to draw at this size, so the fill, the paint and the glow
        // all see the same plate or none of them do.
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
        let site_alpha = plate_mask.as_ref().map_or(silhouette_alpha, Mask::data);
        let mut sites = vec![NO_SITE; box_width * box_height];
        let mut any_site = false;
        for ((site, alpha), silhouette) in sites
            .iter_mut()
            .zip(site_alpha)
            .zip(silhouette_alpha.iter())
        {
            if *alpha >= 128 && *silhouette >= 128 {
                *site = 1;
                any_site = true;
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
                    if style.track_second {
                        second_dist2[roi_index] = best_dist2[roi_index];
                        second_label[roi_index] = best_label[roi_index];
                    }
                    best_dist2[roi_index] = dist2;
                    best_label[roi_index] = label;
                } else if style.track_second && dist2 < second_dist2[roi_index] {
                    second_dist2[roi_index] = dist2;
                    second_label[roi_index] = label;
                }
            }
        }
    }

    // The unlit silhouettes the light spill brightens, rasterised over the ROI
    // in one pass. `None` whenever the effect is off.
    let spill_mask = spill
        .filter(|_| style.spill_boost > 0.0)
        .and_then(|unlit_path| {
            let mut mask = Mask::new(roi_width as u32, roi_height as u32)?;
            mask.fill_path(
                unlit_path,
                FillRule::Winding,
                true,
                Transform::from_translate(-(roi_x0 as f32), -(roi_y0 as f32)),
            );
            Some(mask)
        });

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
            let mut fraction = distance / reach;
            let mut color = lit[hold_index].color;

            // Merge / seam against the second-nearest hold.
            if style.track_second {
                let other = second_label[roi_index];
                if other != NO_SITE && other != label {
                    let other_index = other as usize - 1;
                    let other_distance = ((second_dist2[roi_index] as f32).sqrt() - 0.5).max(0.0);
                    let other_color = lit[other_index].color;
                    if other_color == color {
                        // Smooth-min of the two fields: the lobes bulge toward
                        // each other and fuse instead of meeting on a bisector.
                        if style.merge_softness > 0.0 {
                            let softness = style.merge_softness * reach;
                            if softness > 0.0 {
                                let h = (0.5 + 0.5 * (other_distance - distance) / softness)
                                    .clamp(0.0, 1.0);
                                let softened = other_distance * (1.0 - h) + distance * h
                                    - softness * h * (1.0 - h);
                                fraction = (softened.max(0.0) / reach).min(1.0);
                            }
                        }
                    } else if style.seam_blend > 0.0 {
                        // Crossfade the colours across the bisector band
                        // instead of switching on it.
                        let band = style.seam_blend * reach;
                        let gap = other_distance - distance;
                        if band > 0.0 && gap < band {
                            let t = style.seam_max_mix * (1.0 - gap / band).clamp(0.0, 1.0);
                            color = lerp_color(color, other_color, t);
                        }
                    }
                }
            }

            if fraction >= 1.0 {
                continue;
            }
            let mut alpha = lut.at(fraction);
            if style.apply_gamma {
                alpha = alpha.powf(style.gamma);
            }
            if style.two_tone {
                let whiten =
                    style.core_whiten * (1.0 - smoothstep(0.0, style.core_share, fraction));
                if whiten > 0.0 {
                    color = lerp_color(color, WHITE, whiten);
                }
                let deepen = style.fringe_deepen * smoothstep(style.core_share, 1.0, fraction);
                if deepen > 0.0 {
                    color = lerp_color(color, deepened(lit[hold_index].color), deepen);
                }
            }
            if let Some(mask) = &spill_mask {
                let unlit_coverage = mask.data()[roi_index];
                if unlit_coverage > 0 {
                    alpha = (alpha * (1.0 + style.spill_boost * unlit_coverage as f32 / 255.0))
                        .min(1.0);
                }
            }
            if style.dither > 0.0 && alpha > 0.0 {
                let noise = interleaved_gradient_noise(roi_x0 + x, roi_y0 + y);
                alpha = (alpha + (noise - 0.5) * style.dither).clamp(0.0, 1.0);
            }

            let hold_clear = 1.0 - coverage[roi_index] as f32 / 255.0;
            let offset = (roi_y0 + y) * stride + (roi_x0 + x) * 4;
            let base_alpha = alpha * hold_clear;
            if base_alpha > 0.002 {
                blend_premultiplied(&mut data[offset..offset + 4], color, base_alpha);
            } else if !style.rim {
                continue;
            }
            // The neon rim: a crisp near-white stroke hugging the silhouette,
            // over the glow, still cut by coverage so it never paints the hold.
            if style.rim {
                let rim_width_px = style.rim_width_fraction * lit[hold_index].r_px;
                let rim_profile = (rim_width_px - distance).clamp(0.0, 1.0);
                let rim_alpha = style.rim_opacity * rim_profile * hold_clear;
                if rim_alpha > 0.002 {
                    let rim_color = lerp_color(lit[hold_index].color, WHITE, style.rim_whiten);
                    blend_premultiplied(&mut data[offset..offset + 4], rim_color, rim_alpha);
                }
            }
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

    #[test]
    fn default_style_gates_every_effect_off() {
        let style = GlowStyle::from_tuning(&GlowTuning::default());
        assert!(!style.apply_gamma);
        assert_eq!(style.dither, 0.0);
        assert!(!style.two_tone);
        assert!(!style.rim);
        assert!(!style.track_second);
        assert_eq!(style.spill_boost, 0.0);
    }

    #[test]
    fn style_sanitises_hostile_values() {
        let style = GlowStyle::from_tuning(&GlowTuning {
            falloff_gamma: f32::NAN,
            dither: 9.0,
            core_whiten: -3.0,
            core_share: f32::INFINITY,
            rim_width_fraction: 40.0,
            merge_softness: -1.0,
            seam_blend_fraction: 7.0,
            spill_boost: f32::NEG_INFINITY,
            ..GlowTuning::default()
        });
        assert!(!style.apply_gamma, "NaN gamma falls back to 1.0");
        assert_eq!(style.dither, 0.25);
        assert_eq!(style.core_whiten, 0.0);
        assert_eq!(style.core_share, 0.25, "non-finite share takes the default");
        assert_eq!(style.rim_width_fraction, 0.5);
        assert_eq!(style.merge_softness, 0.0);
        assert_eq!(style.seam_blend, 1.0);
        assert_eq!(style.spill_boost, 0.0);
    }

    #[test]
    fn interleaved_gradient_noise_stays_in_unit_range() {
        for y in 0..64 {
            for x in 0..64 {
                let noise = interleaved_gradient_noise(x, y);
                assert!((0.0..1.0).contains(&noise));
            }
        }
        assert!(
            (interleaved_gradient_noise(10, 10) - interleaved_gradient_noise(11, 10)).abs() > 1e-3,
            "neighbouring pixels get different noise"
        );
    }

    #[test]
    fn colour_helpers_lerp_and_deepen() {
        let cyan = Color {
            r: 0,
            g: 255,
            b: 255,
        };
        assert_eq!(lerp_color(cyan, WHITE, 0.0), cyan);
        assert_eq!(lerp_color(cyan, WHITE, 1.0), WHITE);
        let half = lerp_color(cyan, WHITE, 0.5);
        assert_eq!((half.r, half.g, half.b), (128, 255, 255));
        let deep = deepened(cyan);
        assert_eq!(
            (deep.r, deep.g, deep.b),
            (0, 89, 89),
            "hue survives the deepen"
        );
    }
}
