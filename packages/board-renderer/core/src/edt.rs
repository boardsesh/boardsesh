// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

//! Exact Euclidean distance transform that also says WHICH site is nearest.
//!
//! Felzenszwalb & Huttenlocher's lower-envelope-of-parabolas algorithm
//! ("Distance Transforms of Sampled Functions", 2012): one 1-D pass down every
//! column, one along every row, O(pixels) and exact. The argmin is carried
//! through both passes so every pixel learns the label of its nearest site,
//! which is what lets the glow paint each pixel in the colour of the nearest
//! lit hold — the split between two neighbouring glows falls on the true
//! bisector of the two silhouettes, with no clip paths at all.

/// Label value for "not a site".
pub const NO_SITE: u16 = 0;

/// Squared distance stored for pixels with no site anywhere in the field.
pub const NO_DISTANCE: u32 = u32::MAX;

const INF: f64 = 1e20;

pub struct LabelledDistanceField {
    pub width: usize,
    pub height: usize,
    /// Squared Euclidean distance (in pixels²) to the nearest site, or
    /// `NO_DISTANCE`.
    pub dist2: Vec<u32>,
    /// Label of the nearest site, or `NO_SITE`.
    pub site_label: Vec<u16>,
}

/// One-dimensional squared distance transform with argmin, over `f`.
///
/// `d[q] = min_p (q - p)² + f[p]`, `arg[q] = that p`. `v`, `z` are scratch
/// buffers of length `n` and `n + 1`.
fn transform_1d(f: &[f64], d: &mut [f64], arg: &mut [usize], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let fq = f[q] + (q * q) as f64;
        let mut s;
        loop {
            let vk = v[k];
            let fv = f[vk] + (vk * vk) as f64;
            s = (fq - fv) / (2.0 * (q as f64 - vk as f64));
            if s <= z[k] && k > 0 {
                k -= 1;
            } else {
                break;
            }
        }
        if s <= z[k] {
            // Only reachable when k == 0 and this parabola dominates the first
            // one everywhere. With a finite INF the intersection is always above
            // -INF, so this is belt-and-braces for a future f that admits it.
            v[0] = q;
            z[0] = -INF;
            z[1] = INF;
            k = 0;
        } else {
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let vk = v[k];
        let delta = q as f64 - vk as f64;
        d[q] = delta * delta + f[vk];
        arg[q] = vk;
    }
}

/// Labelled EDT over a `width × height` grid where `labels[i] != NO_SITE`
/// marks a site pixel carrying that label.
pub fn labelled_edt(width: usize, height: usize, labels: &[u16]) -> LabelledDistanceField {
    assert_eq!(labels.len(), width * height, "labels must cover the grid");
    let size = width * height;
    let mut dist2 = vec![NO_DISTANCE; size];
    let mut site_label = vec![NO_SITE; size];
    if size == 0 {
        return LabelledDistanceField {
            width,
            height,
            dist2,
            site_label,
        };
    }

    // Column pass: for every (x, y) the nearest site row within column x.
    let mut col_dist = vec![INF; size];
    let mut col_arg = vec![0usize; size];
    let longest = width.max(height);
    let mut f = vec![0.0f64; longest];
    let mut d = vec![0.0f64; longest];
    let mut arg = vec![0usize; longest];
    let mut v = vec![0usize; longest];
    let mut z = vec![0.0f64; longest + 1];

    for x in 0..width {
        let mut any_site = false;
        for y in 0..height {
            let is_site = labels[y * width + x] != NO_SITE;
            any_site |= is_site;
            f[y] = if is_site { 0.0 } else { INF };
        }
        if !any_site {
            continue; // col_dist stays INF for the whole column
        }
        transform_1d(
            &f[..height],
            &mut d[..height],
            &mut arg[..height],
            &mut v[..height],
            &mut z[..height + 1],
        );
        for y in 0..height {
            col_dist[y * width + x] = d[y];
            col_arg[y * width + x] = arg[y];
        }
    }

    // Row pass: combine columns; the nearest site of (x, y) is
    // (x', col_arg[y][x']) for the argmin column x'.
    for y in 0..height {
        let row = &col_dist[y * width..(y + 1) * width];
        if row.iter().all(|value| *value >= INF) {
            continue;
        }
        f[..width].copy_from_slice(row);
        transform_1d(
            &f[..width],
            &mut d[..width],
            &mut arg[..width],
            &mut v[..width],
            &mut z[..width + 1],
        );
        for x in 0..width {
            let value = d[x];
            if value >= INF / 2.0 {
                continue;
            }
            let site_x = arg[x];
            let site_y = col_arg[y * width + site_x];
            let index = y * width + x;
            dist2[index] = value.round().min(u32::MAX as f64 - 1.0) as u32;
            site_label[index] = labels[site_y * width + site_x];
        }
    }

    LabelledDistanceField {
        width,
        height,
        dist2,
        site_label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brute_force(width: usize, height: usize, labels: &[u16]) -> Vec<(u32, Vec<u16>)> {
        let sites: Vec<(usize, usize, u16)> = (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .filter_map(|(x, y)| {
                let label = labels[y * width + x];
                (label != NO_SITE).then_some((x, y, label))
            })
            .collect();
        (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .map(|(x, y)| {
                let mut best = NO_DISTANCE;
                let mut best_labels = Vec::new();
                for (sx, sy, label) in &sites {
                    let dx = *sx as i64 - x as i64;
                    let dy = *sy as i64 - y as i64;
                    let d2 = (dx * dx + dy * dy) as u32;
                    if d2 < best {
                        best = d2;
                        best_labels = vec![*label];
                    } else if d2 == best {
                        best_labels.push(*label);
                    }
                }
                (best, best_labels)
            })
            .collect()
    }

    // Deterministic LCG so the test never depends on an RNG crate.
    fn pseudo_random(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn matches_brute_force_on_random_masks() {
        let width = 64;
        let height = 48;
        let mut seed = 0x2202u64;
        for round in 0..6 {
            let mut labels = vec![NO_SITE; width * height];
            let blobs = 2 + round;
            for blob in 0..blobs {
                let cx = (pseudo_random(&mut seed) % width as u64) as i64;
                let cy = (pseudo_random(&mut seed) % height as u64) as i64;
                let radius = 2 + (pseudo_random(&mut seed) % 6) as i64;
                for y in 0..height as i64 {
                    for x in 0..width as i64 {
                        if (x - cx).pow(2) + (y - cy).pow(2) <= radius * radius {
                            labels[(y * width as i64 + x) as usize] = blob as u16 + 1;
                        }
                    }
                }
            }
            let field = labelled_edt(width, height, &labels);
            let expected = brute_force(width, height, &labels);
            for (index, (d2, candidate_labels)) in expected.iter().enumerate() {
                assert_eq!(
                    field.dist2[index], *d2,
                    "round {round} pixel {index} distance"
                );
                assert!(
                    candidate_labels.contains(&field.site_label[index]),
                    "round {round} pixel {index}: label {} not among nearest {:?}",
                    field.site_label[index],
                    candidate_labels
                );
            }
        }
    }

    #[test]
    fn empty_field_has_no_sites() {
        let field = labelled_edt(8, 8, &[NO_SITE; 64]);
        assert!(field.dist2.iter().all(|d| *d == NO_DISTANCE));
        assert!(field.site_label.iter().all(|l| *l == NO_SITE));
    }

    #[test]
    fn single_site_distances_are_exact_squares() {
        let width = 5;
        let mut labels = vec![NO_SITE; 25];
        labels[2 * width + 2] = 7;
        let field = labelled_edt(width, 5, &labels);
        assert_eq!(field.dist2[0], 8); // corner: dx=2, dy=2
        assert_eq!(field.dist2[2 * width + 4], 4);
        assert_eq!(field.dist2[2 * width + 2], 0);
        assert!(field.site_label.iter().all(|l| *l == 7));
    }

    #[test]
    fn zero_sized_field_is_fine() {
        let field = labelled_edt(0, 0, &[]);
        assert!(field.dist2.is_empty());
    }
}
