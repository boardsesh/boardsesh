/**
 * The photo→canonical homography of one spray-wall version, by 4-point DLT.
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
 * ## Why this lives here and not in `@boardsesh/spray-wall-geometry`
 *
 * That package is SW-06 (#5439) and does not exist yet. The wall API cannot wait
 * for it — a version row without a homography is not a version — so the minimal
 * solver lives here, in pure TS with no dependencies, and SW-06 moves it into the
 * shared package unchanged. Keep it free of backend imports so that move is a
 * file rename.
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

/** Map one point through a row-major 3x3 homography. Exposed for tests and callers checking a fit. */
export function applyHomography(homography: Homography, x: number, y: number): [number, number] {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = homography;
  const w = h20 * x + h21 * y + h22;
  if (!Number.isFinite(w) || w === 0) return [Number.NaN, Number.NaN];
  return [(h00 * x + h01 * y + h02) / w, (h10 * x + h11 * y + h12) / w];
}
