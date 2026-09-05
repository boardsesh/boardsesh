// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

/**
 * The field-colour veil's strength, and the OkLab lightness it is decided on
 * (issue #2202).
 *
 * The veil is the counterpart to every additive treatment in the spike: instead
 * of spending ink on the 10-16 lit placements out of 198-641, it quiets the
 * other 95-97% by washing the board in the play-field colour with the lit
 * silhouettes punched out. One even-odd path, no mask and no filter.
 */

/**
 * Tuning the spike settled on. Restated here as data rather than inlined so a
 * consumer can show its working, and so the tests can pin the published
 * figures against the thresholds that produced them.
 */
export const VEIL_TUNING = {
  /**
   * Gap between the wall and the field, in OkLab lightness, at or above which
   * the veil goes to full strength. These are gaps and not wall lightnesses:
   * the veil is a wash of the FIELD over the wall, so all it can buy is the
   * difference between the two. On a plywood chip (`#6B4F33`, L 0.450) some
   * boards' walls are DARKER than the field, and washing there would make the
   * wall brighter than the hold it is meant to be quieting behind.
   */
  veilStrongGap: 0.34,
  /** Below `veilStrongGap`, still enough separation to be worth a soft wash. */
  veilSoftGap: 0.175,
  /**
   * 0.60 is the lock-in of 2026-08-27, off the phone-size glow sheets: TB2
   * Mirror's unlit holds go from 3.08 to 2.22 against the field and the share
   * of wall brighter than a HAND glow from 36% to 19%, with the glow itself
   * untouched. Everything captured before then shows 0.45.
   */
  veilStrongOpacity: 0.6,
  veilSoftOpacity: 0.3,
  /**
   * Share of a board's placements that must carry an art reading before the
   * strong bucket is allowed. Under it the board is mostly bare grid, and what
   * the veil dims is the field's own furniture rather than hold art — on both
   * MoonBoards the A-K / 1-18 labels, which are painted into the board art and
   * go down with the wall.
   */
  veilMinCoverage: 0.6,
  /**
   * Under this share of placements with a reading the mean is a handful of
   * samples, not a wall (MoonBoard 1-1 has 4 of 198): no veil at all.
   */
  veilCoverageFloor: 0.1,
} as const;

/**
 * OkLab lightness of a `#rrggbb` colour — the same expression the generator
 * measures the board art with, so a field colour and a wall reading are
 * directly subtractable.
 *
 * A colour this cannot read reports mid-grey rather than falling through to a
 * NaN. NaN compares false against both thresholds and would silently turn the
 * veil off — the weakest outcome, reached by a typo rather than by a
 * measurement. Digits and length are both checked, since `parseInt('zz', 16)`
 * is NaN.
 */
export function oklabLightness(hexColor: string): number {
  const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 0.5;
  const toLinear = (channel: number): number => {
    const normalised = channel / 255;
    return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  };
  const red = toLinear(parseInt(hex.slice(0, 2), 16));
  const green = toLinear(parseInt(hex.slice(2, 4), 16));
  const blue = toLinear(parseInt(hex.slice(4, 6), 16));
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
}

export type VeilInput = {
  /** `WallLightness.mean` for the board being drawn. */
  wallLightness: number;
  /** `WallLightness.coverage` for the same board, 0..1. */
  coverage: number;
  /** The play field the veil washes toward, as `#rrggbb`. */
  fieldColor: string;
};

/**
 * How hard the veil quiets this board's unlit wall, or 0 where there is no wall
 * worth quieting.
 *
 * On the shipped field `#181225` (L 0.200) the catalogue's spike boards come out
 * TB2 Mirror 0.541, Tension Original 0.461, MoonBoard Masters 0.469 (0.441 in the
 * spike, which traced three of its eight sets), Kilter Homewall 0.426, MoonBoard
 * 2016 0.373, Kilter Original 0.325, Grasshopper 0.216 — so the first four take
 * the strong bucket, and the last three the soft one. On a white field every gap is negative and the veil is off.
 */
export function veilOpacityFor({ wallLightness, coverage, fieldColor }: VeilInput): number {
  if (!Number.isFinite(wallLightness) || !Number.isFinite(coverage) || coverage <= 0) return 0;
  if (coverage < VEIL_TUNING.veilCoverageFloor) return 0;
  const gap = wallLightness - oklabLightness(fieldColor);
  const bucket =
    gap >= VEIL_TUNING.veilStrongGap
      ? VEIL_TUNING.veilStrongOpacity
      : gap >= VEIL_TUNING.veilSoftGap
        ? VEIL_TUNING.veilSoftOpacity
        : 0;
  return coverage < VEIL_TUNING.veilMinCoverage ? Math.min(bucket, VEIL_TUNING.veilSoftOpacity) : bucket;
}
