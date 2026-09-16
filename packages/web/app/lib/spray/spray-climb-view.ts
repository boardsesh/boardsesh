import { convertLitUpHoldsStringToMap, toFlatFrames } from '@boardsesh/board-constants';
import { IDENTITY_HOMOGRAPHY, invert, mapPoint, mapRadius, type Homography } from '@boardsesh/spray-wall-geometry';

/**
 * Turning a wall's climb into marks on the wall's photograph.
 *
 * Every other board type on www draws through `/render/board`: a build-time
 * board photo plus a WASM overlay, both addressed by the catalogue tuple. A
 * spray wall has neither. Its background is a photograph its owner took, its
 * holds live in `spray_wall_holds`, and the two are related by a homography
 * stored on the version rather than by a baked-in coordinate system. So this
 * module does the mapping itself and the page draws plain SVG over an `<img>`.
 *
 * The photo is never warped (`docs/spray-walls.md`, "Canonical coordinates"):
 * hold coordinates are canonical-frame pixels and the STORED matrix maps
 * photo -> canonical, so drawing means inverting it once and pushing every
 * centre, radius and silhouette point back into photo pixels.
 */

/** One hold as `sprayWallRenderData` hands it over: canonical-frame pixels. */
export type SprayWallHoldGeometry = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /**
   * Flat, implicitly-closed ring `[x0, y0, x1, y1, …]` in units of THIS hold's
   * own radius, relative to its own centre. Null falls back to the circle
   * `(cx, cy, r)` describes, exactly as an untraced catalogue placement does.
   */
  outline: number[] | null;
};

/** One lit hold, already in the photograph's pixel frame and ready to draw. */
export type SprayLitHoldMark = {
  id: number;
  /** The role's screen colour, e.g. the green a STARTING hold is drawn in. */
  color: string;
  /** Hold role name (`STARTING` / `HAND` / `FINISH` / `FOOT`), for the alt text. */
  role: string;
  cx: number;
  cy: number;
  r: number;
  /** `points` for an SVG `<polygon>`, or null when this hold draws as a circle. */
  polygonPoints: string | null;
};

/** Rounded to a tenth of a pixel: an SVG attribute does not need float noise. */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The photo-pixel marks for the holds a climb lights up.
 *
 * Returns an empty list rather than throwing on a wall whose stored matrix is
 * singular. `invert` throws by design — the backend wants that, because a
 * corrupt matrix silently becoming the identity renders every hold in the wrong
 * place. On a public page the honest degradation is different: show the
 * photograph with no marks on it. A blank page tells the reader nothing, and a
 * 500 on a link someone shared is worse than a picture of the wall.
 */
export function buildSprayLitHoldMarks({
  holds,
  homography,
  frames,
}: {
  holds: readonly SprayWallHoldGeometry[];
  homography: readonly number[] | null | undefined;
  frames: string | null | undefined;
}): SprayLitHoldMark[] {
  if (!frames) return [];

  // The UNION of every frame, not frame 0. This page is a static render, and
  // `toFlatFrames` is what a static render of a multi-frame climb owes
  // the reader — one frame is a fragment of the climb, and for a route the last
  // frame has already dropped whatever an earlier `x` token cleared. It is also
  // what this climb's own OG card draws (`buildSprayOgImageUrl` sends the card
  // a pre-flattened string), so without this the page and the card it links to
  // would light different holds for the same climb.
  const litHolds = convertLitUpHoldsStringToMap(toFlatFrames(frames, 'spray'), 'spray')[0];
  if (!litHolds) return [];

  let canonicalToPhoto: Homography;
  try {
    canonicalToPhoto = invert(
      homography && homography.length === 9 ? ([...homography] as Homography) : IDENTITY_HOMOGRAPHY,
    );
  } catch (error) {
    console.error('[spray] wall homography is not invertible; rendering the photo without holds:', error);
    return [];
  }

  const marks: SprayLitHoldMark[] = [];

  for (const hold of holds) {
    const litHold = litHolds[hold.id];
    if (!litHold) continue;

    const [photoX, photoY] = mapPoint(canonicalToPhoto, hold.cx, hold.cy);
    const photoRadius = hold.r * mapRadius(canonicalToPhoto, hold.cx, hold.cy);

    // A matrix can invert cleanly and still send a hold to infinity: a point on
    // the map's vanishing line divides by a homogeneous w of zero. The browser
    // reads `cx="Infinity"` as 0 and draws the mark in the corner of the
    // photograph rather than dropping it, which is worse than not drawing it —
    // a hold that is not on this climb appears to be. Same guard the backend's
    // card renderer applies to the same arithmetic.
    if (!Number.isFinite(photoX) || !Number.isFinite(photoY)) continue;
    if (!Number.isFinite(photoRadius) || photoRadius <= 0) continue;

    marks.push({
      id: hold.id,
      color: litHold.displayColor || litHold.color,
      role: litHold.state,
      cx: roundToTenth(photoX),
      cy: roundToTenth(photoY),
      r: roundToTenth(photoRadius),
      polygonPoints: buildPolygonPoints(hold, canonicalToPhoto),
    });
  }

  return marks;
}

/**
 * A hold's traced silhouette in photo pixels, or null when it has none.
 *
 * Point by point rather than through one scale factor: the map is projective,
 * so a ring is not the same shape at both ends of an off-axis photo. Ring
 * coordinates arrive in radius units around the hold's centre, so they become
 * canonical pixels (`cx + rx * r`) before they are mapped.
 *
 * One non-finite point discards the whole silhouette rather than the point: a
 * polygon missing a vertex is a different shape drawn confidently, while
 * returning null falls the hold back to its ring, which is the same thing an
 * untraced hold gets.
 */
function buildPolygonPoints(hold: SprayWallHoldGeometry, canonicalToPhoto: Homography): string | null {
  const ring = hold.outline;
  if (!ring || ring.length < 6 || ring.length % 2 !== 0) return null;

  const mappedPoints: string[] = [];
  for (let index = 0; index < ring.length; index += 2) {
    const [photoX, photoY] = mapPoint(
      canonicalToPhoto,
      hold.cx + ring[index] * hold.r,
      hold.cy + ring[index + 1] * hold.r,
    );
    if (!Number.isFinite(photoX) || !Number.isFinite(photoY)) return null;
    mappedPoints.push(`${roundToTenth(photoX)},${roundToTenth(photoY)}`);
  }

  return mappedPoints.join(' ');
}

/**
 * The pixel box the marks are expressed in.
 *
 * The version's own photo dimensions, because canonical is not the photo: a
 * wall whose owner tapped four anchors has a canonical frame that is the anchor
 * quad mapped onto a rectangle, and the marks above land in photo pixels. Only
 * a wall with no anchors has the two agree, which is why the canonical frame is
 * the fallback rather than the first choice.
 */
export function resolveSprayPhotoFrame({
  photoWidth,
  photoHeight,
  boardWidth,
  boardHeight,
}: {
  photoWidth: number | null | undefined;
  photoHeight: number | null | undefined;
  boardWidth: number;
  boardHeight: number;
}): { width: number; height: number } {
  if (photoWidth && photoHeight && photoWidth > 0 && photoHeight > 0) {
    return { width: photoWidth, height: photoHeight };
  }
  return { width: boardWidth, height: boardHeight };
}
