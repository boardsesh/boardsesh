// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

/**
 * Segmentation: recovering hold substance from art that carries none in its
 * alpha channel.
 *
 * Kept out of the package barrel deliberately. Nothing at runtime segments
 * anything — the whole point of this package is that the tracing already
 * happened offline — so these belong to the generator, the dark-art script and
 * the capture gates, reached through the `./segmentation` subpath.
 */

export type { CoincidentGroups, MutableRaster, PlacementCentre, WhiteKeyMask, WhiteKeyOptions } from './white-key';
export { GROUND_FLOOR, buildWhiteKeyMask, erodeEdge, keyOutGround, mergeCoincidentPlacements } from './white-key';
