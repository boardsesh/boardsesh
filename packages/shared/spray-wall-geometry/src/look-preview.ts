/**
 * The on-device preview of the generated wall looks: the photo flattened into
 * a preview tile the way the `spray-wall-art` job flattens it into the art.
 *
 * The job warps pixels (`warpBilinear`). A phone draws the same picture by
 * handing the photo to the renderer with a transform, which costs one image
 * draw instead of a pixel loop. Two renderers, because the platforms differ:
 *
 * - iOS applies a full 4x4 view transform, perspective row included, so one
 *   `transform: [{ matrix }]` on the photo's view is the exact homography
 *   (`perspectiveViewMatrix`).
 * - Android does not. React Native decomposes a view's matrix into translate,
 *   rotate, scale and camera distance before it reaches the view, which throws
 *   away both the perspective row and any skew. There the tile is cut into a
 *   mesh of triangles, and each triangle draws the photo under the affine map
 *   that matches the homography at its corners (`affinePreviewMesh`). An
 *   SVG image transform keeps the full affine on both platforms.
 *
 * Every map here is photo pixels -> TILE pixels: the canonical frame scaled to
 * the tile, which is how the art is scaled to its own size.
 */
import type { Homography, ReferenceSize } from './homography';
import { invert, mapPoint } from './homography';

/** Row-major 3x3 product `left * right`. */
function multiply(left: Homography, right: Homography): Homography {
  const product: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0;
      for (let index = 0; index < 3; index++) sum += left[row * 3 + index] * right[index * 3 + column];
      product.push(sum);
    }
  }
  return product;
}

/**
 * The photo -> tile map: the version's photo -> canonical homography, then the
 * canonical frame scaled onto a `tile`-sized box. A tile with the frame's
 * aspect scales both axes alike; one that does not is stretched to fill, as
 * a fixed-size thumbnail would be.
 */
export function photoToTileHomography(
  photoToCanonical: Homography,
  frame: ReferenceSize,
  tile: ReferenceSize,
): Homography {
  const scale: Homography = [tile.width / frame.width, 0, 0, 0, tile.height / frame.height, 0, 0, 0, 1];
  return multiply(scale, photoToCanonical);
}

/**
 * The `transform: [{ matrix }]` for a view that holds the photo laid out at
 * `layout` points (the photo scaled by `layout.width / photo.width`) at the
 * tile's top-left corner, so the photo lands flattened in the tile.
 *
 * React Native's matrix is column-major (CSS `matrix3d`) and is applied about
 * the view's CENTRE, so the map is wrapped in a move to and from the centre.
 * The z row is the identity and the homography's third row becomes the w row:
 * a perspective divide per point, which is exactly a homography. The result
 * is scaled so w is positive over the view, because a renderer clips points
 * whose w is negative.
 */
export function perspectiveViewMatrix(photoToTile: Homography, photo: ReferenceSize, layout: ReferenceSize): number[] {
  const toPhoto: Homography = [photo.width / layout.width, 0, 0, 0, photo.height / layout.height, 0, 0, 0, 1];
  const centreX = layout.width / 2;
  const centreY = layout.height / 2;
  const fromCentre: Homography = [1, 0, centreX, 0, 1, centreY, 0, 0, 1];
  const toCentre: Homography = [1, 0, -centreX, 0, 1, -centreY, 0, 0, 1];
  // The view applies centre o M o -centre to layout points; we want photoToTile o toPhoto.
  let matrix = multiply(toCentre, multiply(multiply(photoToTile, toPhoto), fromCentre));
  // w at the view's centre (layout origin of the centred frame) is matrix[8].
  if (matrix[8] < 0) matrix = matrix.map((value) => -value);
  if (matrix[8] !== 0) matrix = matrix.map((value) => value / matrix[8]);
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix;
  return [m00, m10, 0, m20, m01, m11, 0, m21, 0, 0, 1, 0, m02, m12, 0, m22];
}

/**
 * Apply a React Native view matrix the way the renderer does: about the
 * view's centre, with the perspective divide. Exported for the tests, which
 * pin that the matrix above puts the photo's corners where the homography does.
 */
export function applyViewMatrix(
  matrix: readonly number[],
  layout: ReferenceSize,
  x: number,
  y: number,
): [number, number] {
  const localX = x - layout.width / 2;
  const localY = y - layout.height / 2;
  const outX = matrix[0] * localX + matrix[4] * localY + matrix[12];
  const outY = matrix[1] * localX + matrix[5] * localY + matrix[13];
  const outW = matrix[3] * localX + matrix[7] * localY + matrix[15];
  return [outX / outW + layout.width / 2, outY / outW + layout.height / 2];
}

/** SVG `matrix(a b c d e f)`: x' = a x + c y + e, y' = b x + d y + f. */
export type AffineMatrix = [number, number, number, number, number, number];

/**
 * One triangle of the Android mesh: its corners in tile pixels (flat
 * `[x0, y0, x1, y1, x2, y2]`) and the photo -> tile affine drawn inside it.
 * Each triangle's affine is exact at its three corners, so neighbours agree
 * along every shared edge and the mesh has no seams to hide.
 */
export type PreviewMeshTriangle = { points: AffineMatrix; matrix: AffineMatrix };

export type PreviewMesh = { triangles: PreviewMeshTriangle[]; divisions: number; maxError: number };

/** Largest grid the mesh grows to: 8 x 8 cells, two triangles each. Past it the error is left as it is. */
export const PREVIEW_MESH_MAX_DIVISIONS = 8;

/** Tile pixels a triangle's affine may sit from the homography before the grid is refined. */
export const PREVIEW_MESH_TOLERANCE_PX = 0.5;

/** The affine taking photo points `p0, p1, p2` to tile points `t0, t1, t2`, or null when they are collinear. */
function affineFromTriangles(photoPoints: [number, number][], tilePoints: [number, number][]): AffineMatrix | null {
  const [[px0, py0], [px1, py1], [px2, py2]] = photoPoints;
  const [[tx0, ty0], [tx1, ty1], [tx2, ty2]] = tilePoints;
  // Columns are the photo edge vectors; their inverse solves A * P = T.
  const p00 = px1 - px0;
  const p01 = px2 - px0;
  const p10 = py1 - py0;
  const p11 = py2 - py0;
  const determinant = p00 * p11 - p01 * p10;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const i00 = p11 / determinant;
  const i01 = -p01 / determinant;
  const i10 = -p10 / determinant;
  const i11 = p00 / determinant;
  const t00 = tx1 - tx0;
  const t01 = tx2 - tx0;
  const t10 = ty1 - ty0;
  const t11 = ty2 - ty0;
  const a = t00 * i00 + t01 * i10;
  const c = t00 * i01 + t01 * i11;
  const b = t10 * i00 + t11 * i10;
  const d = t10 * i01 + t11 * i11;
  return [a, b, c, d, tx0 - a * px0 - c * py0, ty0 - b * px0 - d * py0];
}

function applyAffine(matrix: AffineMatrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

function triangleAt(tileToPhoto: Homography, tilePoints: [number, number][]) {
  const photoPoints = tilePoints.map(([x, y]) => mapPoint(tileToPhoto, x, y));
  if (photoPoints.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const matrix = affineFromTriangles(photoPoints, tilePoints);
  if (!matrix) return null;
  // Exact at the corners; furthest out at the edge midpoints and the centroid.
  const [[ax, ay], [bx, by], [cx, cy]] = tilePoints;
  let error = 0;
  for (const [checkX, checkY] of [
    [(ax + bx) / 2, (ay + by) / 2],
    [(bx + cx) / 2, (by + cy) / 2],
    [(ax + cx) / 2, (ay + cy) / 2],
    [(ax + bx + cx) / 3, (ay + by + cy) / 3],
  ]) {
    const [photoX, photoY] = mapPoint(tileToPhoto, checkX, checkY);
    const [drawnX, drawnY] = applyAffine(matrix, photoX, photoY);
    error = Math.max(error, Math.hypot(drawnX - checkX, drawnY - checkY));
  }
  const triangle: PreviewMeshTriangle = { points: [ax, ay, bx, by, cx, cy], matrix };
  return { triangle, error };
}

function meshAt(tileToPhoto: Homography, tile: ReferenceSize, divisions: number): PreviewMesh | null {
  const triangles: PreviewMeshTriangle[] = [];
  let maxError = 0;
  const cellWidth = tile.width / divisions;
  const cellHeight = tile.height / divisions;
  for (let row = 0; row < divisions; row++) {
    for (let column = 0; column < divisions; column++) {
      const x0 = column * cellWidth;
      const y0 = row * cellHeight;
      const x1 = column === divisions - 1 ? tile.width : x0 + cellWidth;
      const y1 = row === divisions - 1 ? tile.height : y0 + cellHeight;
      for (const corners of [
        [
          [x0, y0],
          [x1, y0],
          [x0, y1],
        ],
        [
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
      ] as [number, number][][]) {
        const made = triangleAt(tileToPhoto, corners);
        if (!made) return null;
        triangles.push(made.triangle);
        maxError = Math.max(maxError, made.error);
      }
    }
  }
  return { triangles, divisions, maxError };
}

/**
 * The coarsest grid (1, 2, 3 ... `maxDivisions` cells per side, two triangles
 * per cell) whose affine maps stay within `tolerance` tile pixels of the
 * homography, or the finest grid when none does. A front-on photo is two
 * triangles; a keystoned one up to 128. Null when the map is undefined somewhere on the tile (a singular or
 * folding matrix), in which case there is nothing honest to draw.
 */
export function affinePreviewMesh(
  photoToTile: Homography,
  tile: ReferenceSize,
  { maxDivisions = PREVIEW_MESH_MAX_DIVISIONS, tolerance = PREVIEW_MESH_TOLERANCE_PX } = {},
): PreviewMesh | null {
  if (!(tile.width > 0) || !(tile.height > 0)) return null;
  let tileToPhoto: Homography;
  try {
    tileToPhoto = invert(photoToTile);
  } catch {
    return null;
  }
  let mesh: PreviewMesh | null = null;
  for (let divisions = 1; divisions <= maxDivisions; divisions++) {
    mesh = meshAt(tileToPhoto, tile, divisions);
    if (!mesh) return null;
    if (mesh.maxError <= tolerance) return mesh;
  }
  return mesh;
}
