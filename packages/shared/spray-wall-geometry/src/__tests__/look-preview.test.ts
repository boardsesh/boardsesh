import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY, homographyFromAnchors, invert, mapPoint, type Quad } from '../homography';
import {
  PREVIEW_MESH_MAX_DIVISIONS,
  affinePreviewMesh,
  applyViewMatrix,
  perspectiveViewMatrix,
  photoToTileHomography,
} from '../look-preview';

// A keystoned wall: the top edge pinned at half the bottom's width (the
// photo-quality spike's strongly angled case).
const KEYSTONE: Quad = [
  [700, 200],
  [1700, 200],
  [2200, 1700],
  [200, 1700],
];
const PHOTO = { width: 2400, height: 1800 };

function setup(quad: Quad) {
  const frame = { width: 2000, height: 1500 };
  const photoToCanonical = homographyFromAnchors(quad, frame);
  const tile = { width: 120, height: 90 };
  return { frame, tile, photoToTile: photoToTileHomography(photoToCanonical, frame, tile) };
}

function expectClose(actual: [number, number], expected: [number, number], digits = 6) {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
}

describe('photoToTileHomography', () => {
  it('puts the pinned corners on the tile corners', () => {
    const { tile, photoToTile } = setup(KEYSTONE);
    const corners: [number, number][] = [
      [0, 0],
      [tile.width, 0],
      [tile.width, tile.height],
      [0, tile.height],
    ];
    KEYSTONE.forEach(([x, y], index) => expectClose(mapPoint(photoToTile, x, y), corners[index]));
  });
});

describe('perspectiveViewMatrix', () => {
  it('lands the pinned photo corners on the tile corners, through the renderer’s centre-origin maths', () => {
    const { tile, photoToTile } = setup(KEYSTONE);
    const layout = { width: 180, height: 135 };
    const matrix = perspectiveViewMatrix(photoToTile, PHOTO, layout);
    expect(matrix).toHaveLength(16);
    const toLayout = layout.width / PHOTO.width;
    const corners: [number, number][] = [
      [0, 0],
      [tile.width, 0],
      [tile.width, tile.height],
      [0, tile.height],
    ];
    KEYSTONE.forEach(([x, y], index) =>
      expectClose(applyViewMatrix(matrix, layout, x * toLayout, y * toLayout), corners[index], 4),
    );
    // A perspective map, so the w row is not the identity's.
    expect(Math.abs(matrix[3]) + Math.abs(matrix[7])).toBeGreaterThan(0);
  });

  it('is a plain fit for an identity homography: a scale, no perspective', () => {
    const frame = { width: 2400, height: 1800 };
    const tile = { width: 120, height: 90 };
    const photoToTile = photoToTileHomography(IDENTITY_HOMOGRAPHY, frame, tile);
    const layout = { width: 120, height: 90 };
    const matrix = perspectiveViewMatrix(photoToTile, PHOTO, layout);
    expect(matrix.map((value) => Math.round(value * 1e9) / 1e9 + 0)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expectClose(applyViewMatrix(matrix, layout, 60, 45), [60, 45]);
  });

  it('keeps w positive at the view centre whatever sign the stored matrix has', () => {
    const { photoToTile } = setup(KEYSTONE);
    const flipped = photoToTile.map((value) => -value);
    const matrix = perspectiveViewMatrix(flipped, PHOTO, { width: 180, height: 135 });
    expect(matrix[15]).toBeCloseTo(1, 9);
  });
});

// A wall the gate passes as "soft": bottom corners pinned a quarter in.
const SOFT: Quad = [
  [500, 200],
  [1900, 200],
  [2200, 1700],
  [200, 1700],
];

describe('affinePreviewMesh', () => {
  it('is two triangles for a front-on photo', () => {
    const frame = { width: 2400, height: 1800 };
    const tile = { width: 120, height: 90 };
    const mesh = affinePreviewMesh(photoToTileHomography(IDENTITY_HOMOGRAPHY, frame, tile), tile)!;
    expect(mesh.divisions).toBe(1);
    expect(mesh.triangles).toHaveLength(2);
    expect(mesh.triangles[0].points).toEqual([0, 0, 120, 0, 0, 90]);
    for (const { matrix } of mesh.triangles) {
      expect(matrix.map((value) => Math.round(value * 1e9) / 1e9 + 0)).toEqual([0.05, 0, 0, 0.05, 0, 0]);
    }
  });

  it.each([
    ['soft', SOFT],
    ['keystoned', KEYSTONE],
  ])('refines a %s photo, exact at every triangle corner and covering the tile', (_name, quad) => {
    const { tile, photoToTile } = setup(quad);
    const mesh = affinePreviewMesh(photoToTile, tile)!;
    expect(mesh.divisions).toBeGreaterThan(1);
    expect(mesh.divisions).toBeLessThanOrEqual(PREVIEW_MESH_MAX_DIVISIONS);
    expect(mesh.triangles).toHaveLength(2 * mesh.divisions ** 2);
    const area = mesh.triangles.reduce((sum, { points: [ax, ay, bx, by, cx, cy] }) => {
      return sum + Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }, 0);
    expect(area).toBeCloseTo(tile.width * tile.height, 6);
    const tileToPhoto = invert(photoToTile);
    for (const { points, matrix } of mesh.triangles) {
      const [a, b, c, d, e, f] = matrix;
      for (let index = 0; index < 6; index += 2) {
        const [photoX, photoY] = mapPoint(tileToPhoto, points[index], points[index + 1]);
        expectClose([a * photoX + c * photoY + e, b * photoX + d * photoY + f], [points[index], points[index + 1]], 6);
      }
    }
  });

  it('keeps a photo the gate passes within half a tile pixel', () => {
    const { tile, photoToTile } = setup(SOFT);
    expect(affinePreviewMesh(photoToTile, tile)!.maxError).toBeLessThanOrEqual(0.5);
  });

  it('is null for a singular map or an empty tile', () => {
    expect(affinePreviewMesh([0, 0, 0, 0, 0, 0, 0, 0, 0], { width: 10, height: 10 })).toBeNull();
    expect(affinePreviewMesh(IDENTITY_HOMOGRAPHY, { width: 0, height: 10 })).toBeNull();
  });
});
