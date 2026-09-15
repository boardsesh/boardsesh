/**
 * The photo <-> canonical homography of one spray-wall version, by 4-point DLT.
 *
 * A wall is photographed from wherever the climber stood, so the same hold sits
 * at a different pixel in every version's photo. The four anchors are the wall's
 * corners as tapped in THAT photo; mapping them onto a rectangle gives the one
 * transform that makes two photographs agree on where a hold is, which is what a
 * reset needs (`docs/spray-walls.md`).
 *
 * No image is ever warped in v1: this matrix is stored and the renderer maps
 * holds through its inverse at draw time.
 *
 * Moved here from `packages/backend/src/lib/spray-wall-homography.ts` (SW-05,
 * #5438), which said in so many words that SW-06 would take it. The solver and
 * its tests arrived unchanged; `invert`, `mapPoint`, `mapRing` and `mapRadius`
 * are new, because the reset matcher and the render path need the inverse
 * direction the backend never did.
 */

/** Row-major 3x3, nine floats — the shape `spray_wall_versions.homography` stores. */
export type Homography = number[];

/** Four points in TL/TR/BR/BL order, as `[x, y]` pairs. */
export type Quad = [number, number][];

/** The canonical frame a quad is mapped onto: its width and height in pixels. */
export type ReferenceSize = { width: number; height: number };

/** Row-major 3x3 identity. What a version with no anchors stores. */
export const IDENTITY_HOMOGRAPHY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * A quad is exactly four finite `[x, y]` pairs. Anything else is not a quad we
 * can solve, and a partially-numeric one would silently produce a matrix full of
 * NaN that every downstream render would then draw nothing from.
 */
export function isValidAnchorQuad(quad: unknown): quad is Quad {
  return (
    Array.isArray(quad) &&
    quad.length === 4 &&
    quad.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((value) => typeof value === 'number' && Number.isFinite(value)),
    )
  );
}

/**
 * The axis-aligned box a quad covers, rounded out to whole pixels.
 *
 * This is how version 1 derives the wall's canonical frame when anchors were
 * tapped: the owner decision (2026-09-14) is that a wall has no real-world
 * dimensions, so the frame is whatever the photo says it is.
 */
export function boundingSize(quad: Quad): ReferenceSize {
  const xs = quad.map(([x]) => x);
  const ys = quad.map(([, y]) => y);
  return {
    width: Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs))),
    height: Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys))),
  };
}

/**
 * Smallest edge, in pixels, a usable anchor quad may have, and the smallest
 * fraction of its own bounding box its area may cover.
 *
 * Both are loose on purpose. A photograph taken hard off to one side is a narrow
 * trapezoid and is perfectly usable; what is not usable is a quad with no area —
 * four taps in a line, or on top of each other. 2% of the bounding box rejects
 * those and nothing a person would actually tap.
 */
const MIN_QUAD_EDGE_PX = 8;
const MIN_QUAD_AREA_FRACTION = 0.02;

/**
 * Twice the signed area of a quad, by the shoelace formula.
 *
 * Signed, so a quad tapped clockwise and the same quad tapped anticlockwise come
 * out with opposite signs — callers take the absolute value. Zero means the four
 * points enclose nothing.
 */
export function quadDoubleArea(quad: Quad): number {
  let total = 0;
  for (let index = 0; index < 4; index++) {
    const [x1, y1] = quad[index];
    const [x2, y2] = quad[(index + 1) % 4];
    total += x1 * y2 - x2 * y1;
  }
  return total;
}

/**
 * Cross products of consecutive edges around the ring, one per vertex.
 *
 * The sign of each says which way the boundary turns there. All four the same
 * sign means a convex, non-self-intersecting quadrilateral; mixed signs mean
 * either a concave one or a bow-tie, and a zero means three of the four points
 * are collinear.
 */
function quadTurns(quad: Quad): number[] {
  return quad.map((_, index) => {
    const [x0, y0] = quad[index];
    const [x1, y1] = quad[(index + 1) % 4];
    const [x2, y2] = quad[(index + 2) % 4];
    return (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
  });
}

/**
 * Is this quad convex and non-self-intersecting?
 *
 * The bounding-box and shoelace-area rules alone are not enough, which is the
 * bug this function fixes. `[[0, 0], [100, 0], [40, 40], [0, 100]]` is concave
 * and clears both — a big box, 2,000 units of enclosed area — but the homography
 * it produces has a denominator (`h20·x + h21·y + 1`) that crosses ZERO inside
 * the wall. Every hold near that line maps to infinity, and holds on opposite
 * sides of it come out mirrored. A bow-tie is worse and just as admissible to a
 * shoelace test, because the two lobes' signed areas partly cancel rather than
 * summing to nothing.
 *
 * Consistent turn signs is the whole test for a four-gon. Strict, so three
 * collinear anchors — one turn of zero — are refused too: that is a triangle with
 * a redundant tap, and the DLT has no unique solution for it.
 */
export function isConvexQuad(quad: Quad): boolean {
  const turns = quadTurns(quad);
  return turns.every((turn) => turn > 0) || turns.every((turn) => turn < 0);
}

/**
 * Whether a quad describes a shape a homography can actually be solved from.
 *
 * This is the gate `createSprayWallVersion` needs rather than the identity
 * fallback further down. On version 1 the anchors also DEFINE the canonical
 * frame — `boundingSize` derives `reference_width` / `reference_height` from
 * them — and the frame is inherited by every later version forever. So a
 * degenerate quad accepted at creation does not merely lose a transform; it pins
 * a 1x1 (or 8x0) coordinate space on the wall for good, and every hold ever drawn
 * on it lands in the same pixel. Refusing it at the door is the only cheap moment.
 *
 * Three rules, and the convexity one is not optional — see {@link isConvexQuad}
 * for the concave quad that passes the other two and still puts a division by
 * zero in the middle of the wall.
 */
export function isSolvableAnchorQuad(quad: unknown): quad is Quad {
  if (!isValidAnchorQuad(quad)) return false;

  const { width, height } = boundingSize(quad);
  if (width < MIN_QUAD_EDGE_PX || height < MIN_QUAD_EDGE_PX) return false;

  // Compared against the bounding box rather than an absolute pixel count so the
  // rule reads the same for a phone photo and a 40-megapixel one.
  if (Math.abs(quadDoubleArea(quad)) / 2 < width * height * MIN_QUAD_AREA_FRACTION) return false;

  return isConvexQuad(quad);
}

/**
 * Solve a dense linear system by Gauss-Jordan elimination with partial pivoting.
 *
 * Eight equations is small enough that an off-the-shelf linear-algebra
 * dependency would cost more than it saves, and partial pivoting is what keeps a
 * near-degenerate quad (three anchors almost in a line) from dividing by a
 * pivot that is only nonzero through floating-point noise. Returns null when the
 * matrix is singular — i.e. the four anchors do not describe a quadrilateral.
 */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length;
  // Work on a copy: the caller's rows are built per call, but a solver that
  // mutates its input is a trap for the next reader.
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);

  for (let column = 0; column < size; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow][column];
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null;

    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];

    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column] / augmented[column][column];
      if (factor === 0) continue;
      for (let col = column; col <= size; col++) {
        augmented[row][col] -= factor * augmented[column][col];
      }
    }
  }

  // Full Gauss-Jordan leaves the matrix diagonal, so there is no back
  // substitution to do: each unknown is its row's right-hand side over its own
  // diagonal entry.
  return augmented.map((row, index) => row[size] / row[index]);
}

/**
 * The photo→canonical homography mapping `quad` (TL/TR/BR/BL in photo pixels)
 * onto the rectangle `(0, 0)-(width, height)`.
 *
 * Returns the identity matrix when there are no usable anchors — which is the
 * honest answer for a version whose photo IS its frame, and what every version
 * created without anchors stores. Anchors are optional at creation and required
 * at the first reset, because that is the point at which two photographs have to
 * agree.
 *
 * The DLT: a homography has 8 degrees of freedom (h22 is fixed at 1), and each
 * corner correspondence gives two equations, so four corners determine it
 * exactly with no least-squares step to make.
 */
export function homographyFromAnchors(quad: unknown, referenceSize: ReferenceSize): Homography {
  if (!isValidAnchorQuad(quad)) return [...IDENTITY_HOMOGRAPHY];

  const { width, height } = referenceSize;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [...IDENTITY_HOMOGRAPHY];
  }

  // The destination corners, in the same TL/TR/BR/BL order as the anchors.
  const destination: Quad = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];

  const matrix: number[][] = [];
  const rhs: number[] = [];

  for (let corner = 0; corner < 4; corner++) {
    const [sourceX, sourceY] = quad[corner];
    const [destX, destY] = destination[corner];

    // destX = (h00·x + h01·y + h02) / (h20·x + h21·y + 1), rearranged so the
    // unknowns are linear: the two -destX·x / -destX·y terms are the projective
    // part, and they are why this is a homography rather than an affine fit.
    matrix.push([sourceX, sourceY, 1, 0, 0, 0, -destX * sourceX, -destX * sourceY]);
    rhs.push(destX);
    matrix.push([0, 0, 0, sourceX, sourceY, 1, -destY * sourceX, -destY * sourceY]);
    rhs.push(destY);
  }

  const solved = solveLinearSystem(matrix, rhs);
  // A degenerate quad (collinear or coincident anchors) has no homography. The
  // identity is a worse map than a correct one but a far better outcome than a
  // matrix of NaN, which would make every hold on the wall render at nowhere.
  if (!solved || solved.some((value) => !Number.isFinite(value))) return [...IDENTITY_HOMOGRAPHY];

  return [...solved, 1];
}

/** Map one point through a row-major 3x3 homography. */
export function mapPoint(homography: Homography, x: number, y: number): [number, number] {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = homography;
  const w = h20 * x + h21 * y + h22;
  if (!Number.isFinite(w) || w === 0) return [Number.NaN, Number.NaN];
  return [(h00 * x + h01 * y + h02) / w, (h10 * x + h11 * y + h12) / w];
}

/**
 * The canonical→photo direction: the adjugate, which is the inverse up to a
 * scale factor a homography does not care about.
 *
 * This is the one the renderer uses. No image is warped in v1, so a hold stored
 * in canonical coordinates has to be pushed back through this matrix before it
 * can be drawn on top of the version's photo.
 *
 * THROWS on a singular matrix, unlike `homographyFromAnchors`, which falls back
 * to the identity. The difference is deliberate: that function is handed
 * user-tapped anchors and has to survive whatever arrives, whereas this one is
 * handed a matrix the system itself stored, so a singular input is a bug
 * upstream. Returning the identity here would draw every hold at its canonical
 * coordinate on top of the photo — plausible-looking, completely wrong, and
 * silent.
 */
export function invert(homography: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = homography;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new Error(`homography is singular (determinant ${determinant}), so it has no inverse`);
  }

  const adjugate = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  // Normalised by the new bottom-right entry rather than by the determinant: a
  // homography is only defined up to scale, and keeping h22 at 1 means a matrix
  // that round-trips through invert() twice compares equal to the one it started
  // as.
  //
  // `adjugate[8]` is `a·e - b·d`, which can be zero for a perfectly invertible
  // matrix (the affine part is degenerate while the projective part is not). The
  // inverse still exists; it just cannot be written with h22 = 1. Dividing by the
  // determinant instead gives the true inverse rather than a scaled one, so the
  // double round trip still maps every point back to itself — only the matrices
  // themselves differ by a constant, which a homography does not care about.
  const scale = adjugate[8];
  if (!Number.isFinite(scale) || scale === 0) return adjugate.map((value) => value / determinant);
  return adjugate.map((value) => value / scale);
}

/**
 * Map a flat ring — `[x0, y0, x1, y1, ...]`, implicitly closed, the
 * `@boardsesh/board-art-geometry` contract — through a homography.
 *
 * Every point separately, because a homography is not affine: the far side of a
 * wall photographed off-axis is compressed more than the near side, and a hold's
 * silhouette has to compress with it.
 */
export function mapRing(homography: Homography, ring: readonly number[]): number[] {
  const mapped: number[] = [];
  for (let index = 0; index + 1 < ring.length; index += 2) {
    const [x, y] = mapPoint(homography, ring[index], ring[index + 1]);
    mapped.push(x, y);
  }
  return mapped;
}

/**
 * How a radius at `(x, y)` scales through the homography, from the local
 * Jacobian.
 *
 * A circle does not stay a circle under a projective map — it becomes an ellipse
 * — so there is no single right answer. `sqrt(|det J|)` is the radius that
 * preserves the hold's AREA, which is what keeps a wall of holds looking evenly
 * sized after the map; taking one axis instead would make every hold on the far
 * side visibly wrong in the other direction.
 *
 * Returns 1 where the map is singular at that point, so a caller gets the
 * unscaled radius rather than 0 or NaN.
 */
export function mapRadius(homography: Homography, x: number, y: number): number {
  const [h00, h01, , h10, h11, , h20, h21, h22] = homography;
  const w = h20 * x + h21 * y + h22;
  if (!Number.isFinite(w) || w === 0) return 1;

  const [mappedX, mappedY] = mapPoint(homography, x, y);
  // d(u)/dx = (h00 - u·h20) / w, and so on: the quotient rule on u = (...)/w.
  const dudx = (h00 - mappedX * h20) / w;
  const dudy = (h01 - mappedX * h21) / w;
  const dvdx = (h10 - mappedY * h20) / w;
  const dvdy = (h11 - mappedY * h21) / w;

  const determinant = Math.abs(dudx * dvdy - dudy * dvdx);
  return Number.isFinite(determinant) && determinant > 0 ? Math.sqrt(determinant) : 1;
}
