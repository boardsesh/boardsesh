// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vite-plus/test';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { getStaticAssetObjectKey } from '@boardsesh/static-assets';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { getLargestGalleryBoardSize, getOrderedGalleryLayouts } from '../board-gallery-config';
import { compactBoardLayoutName, getBoardGalleryLayouts } from '../board-gallery';
import manifest from '../board-gallery-manifest.json';

type CatalogBoardName = Exclude<BoardName, 'spray'>;
type ExpectedLayout = {
  boardName: CatalogBoardName;
  layoutId: number;
  sizeId: number;
  physicalWidth: number;
  physicalHeight: number;
};

// Independently checked against catalog edge extents, rather than default sizes.
// Keep the user-facing order here so old art and old ordering both fail this guard.
const EXPECTED_LAYOUTS = [
  { boardName: 'kilter', layoutId: 1, sizeId: 28, physicalWidth: 192, physicalHeight: 156 },
  { boardName: 'kilter', layoutId: 8, sizeId: 25, physicalWidth: 112, physicalHeight: 156 },
  { boardName: 'tension', layoutId: 10, sizeId: 10, physicalWidth: 184, physicalHeight: 144 },
  { boardName: 'tension', layoutId: 11, sizeId: 10, physicalWidth: 184, physicalHeight: 144 },
  { boardName: 'tension', layoutId: 9, sizeId: 1, physicalWidth: 96, physicalHeight: 156 },
  { boardName: 'moonboard', layoutId: 7, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 3, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 6, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 5, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 4, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 2, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'moonboard', layoutId: 1, sizeId: 1, physicalWidth: 11, physicalHeight: 18 },
  { boardName: 'decoy', layoutId: 2, sizeId: 1, physicalWidth: 136, physicalHeight: 144 },
  { boardName: 'touchstone', layoutId: 1, sizeId: 1, physicalWidth: 144, physicalHeight: 156 },
  { boardName: 'grasshopper', layoutId: 1, sizeId: 4, physicalWidth: 136, physicalHeight: 144 },
  { boardName: 'soill', layoutId: 1, sizeId: 2, physicalWidth: 144, physicalHeight: 160 },
  { boardName: 'woods', layoutId: 1, sizeId: 2, physicalWidth: 33, physicalHeight: 31 },
] as const satisfies readonly ExpectedLayout[];

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');
const catalogBoards = SUPPORTED_BOARDS.filter((boardName): boardName is CatalogBoardName => boardName !== 'spray');
const sha256 = (contents: Buffer): string => createHash('sha256').update(contents).digest('hex');

describe('board gallery catalog', () => {
  it('covers every real catalog layout exactly once across eight brands', () => {
    const catalogKeys = catalogBoards.flatMap((boardName) =>
      getBoardLayouts(boardName).map((layout) => `${boardName}/${layout.id}`),
    );
    const expectedKeys = EXPECTED_LAYOUTS.map(({ boardName, layoutId }) => `${boardName}/${layoutId}`);
    expect(catalogBoards).toHaveLength(8);
    expect(expectedKeys).toHaveLength(17);
    expect([...catalogKeys].sort()).toEqual([...expectedKeys].sort());
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
  });

  it.each(EXPECTED_LAYOUTS)(
    'chooses the largest physical catalog size for $boardName/$layoutId',
    ({ boardName, layoutId, sizeId, physicalWidth, physicalHeight }) => {
      const selectedSize = getLargestGalleryBoardSize(boardName, layoutId);
      expect(selectedSize.id).toBe(sizeId);
      expect(selectedSize.edgeRight - selectedSize.edgeLeft).toBe(physicalWidth);
      expect(selectedSize.edgeTop - selectedSize.edgeBottom).toBe(physicalHeight);
    },
  );

  it('breaks the Homewall equal-area tie with the more complete hold collection', () => {
    const sizes = getBoardSizesForLayoutId('kilter', 8);
    const fullRide = sizes.find((size) => size.id === 25);
    const mainline = sizes.find((size) => size.id === 26);
    expect(fullRide).toBeDefined();
    expect(mainline).toBeDefined();
    expect(fullRide).toMatchObject({ edgeLeft: -56, edgeRight: 56, edgeBottom: -12, edgeTop: 144 });
    expect(mainline).toMatchObject({ edgeLeft: -56, edgeRight: 56, edgeBottom: -12, edgeTop: 144 });
    expect(getBoardSetsForLayoutAndSize('kilter', 8, 25)).toHaveLength(4);
    expect(getBoardSetsForLayoutAndSize('kilter', 8, 26)).toHaveLength(3);
    expect(getLargestGalleryBoardSize('kilter', 8).id).toBe(25);
  });

  it('shows Board 2 first while preserving the catalog Mirror/Spray order', () => {
    const expectedNames = ['Tension Board 2 Mirror', 'Tension Board 2 Spray', 'Original Layout'];
    expect(getOrderedGalleryLayouts('tension').map((layout) => layout.name)).toEqual(expectedNames);
    expect(getBoardGalleryLayouts('tension').map((layout) => layout.layoutName)).toEqual(expectedNames);
  });

  it('shows MoonBoard layouts newest first, including Mini and Masters editions', () => {
    const expectedNames = [
      'Mini MoonBoard 2025',
      'MoonBoard 2024',
      'Mini MoonBoard 2020',
      'MoonBoard Masters 2019',
      'MoonBoard Masters 2017',
      'MoonBoard 2016',
      'MoonBoard 2010',
    ];
    expect(getOrderedGalleryLayouts('moonboard').map((layout) => layout.name)).toEqual(expectedNames);
    expect(getBoardGalleryLayouts('moonboard').map((layout) => layout.layoutName)).toEqual(expectedNames);
  });

  it.each([
    ['kilter', 'Kilter Board Original', 'Original'],
    ['kilter', 'Kilter Board Homewall', 'Homewall'],
    ['tension', 'Original Layout', 'Original'],
    ['tension', 'Tension Board 2 Mirror', 'Board 2 Mirror'],
    ['tension', 'Tension Board 2 Spray', 'Board 2 Spray'],
    ['moonboard', 'MoonBoard Masters 2017', 'Masters 2017'],
    ['moonboard', 'MoonBoard Masters 2019', 'Masters 2019'],
    ['moonboard', 'Mini MoonBoard 2020', 'Mini 2020'],
    ['moonboard', 'Mini MoonBoard 2025', 'Mini 2025'],
  ])('keeps the distinguishing caption for %s / %s', (boardName, layoutName, expectedCaption) => {
    expect(compactBoardLayoutName(boardName, layoutName)).toBe(expectedCaption);
  });
});

describe('generated native board art', () => {
  it('resolves every gallery image through the production immutable asset catalog', () => {
    const productionOrigin = 'https://assets.boardsesh.com';
    for (const image of manifest.layouts) {
      const objectKey = getStaticAssetObjectKey(image.src);
      expect(objectKey, image.src).toBeDefined();
      expect(objectKey, image.src).toMatch(/^static\/v1\/[a-f0-9]{64}\.webp$/);
      expect(objectKey, image.src).toContain(image.sha256);
      const productionUrl = new URL(resolveStaticAssetUrl(image.src, productionOrigin));
      expect(productionUrl.origin).toBe(productionOrigin);
      expect(productionUrl.pathname.slice(1)).toBe(objectKey);
    }
  });

  it('publishes all 17 unique images in gallery order at the selected physical sizes', () => {
    expect(manifest.renderer).toBe('composeBoardBaseBuffer');
    expect(manifest.layouts).toHaveLength(17);
    expect(new Set(manifest.layouts.map((layout) => layout.src)).size).toBe(17);
    expect(manifest.layouts.map(({ boardName, layoutId, sizeId }) => `${boardName}/${layoutId}:${sizeId}`)).toEqual(
      EXPECTED_LAYOUTS.map(({ boardName, layoutId, sizeId }) => `${boardName}/${layoutId}:${sizeId}`),
    );
    for (const expectedLayout of EXPECTED_LAYOUTS) {
      const image = manifest.layouts.find(
        ({ boardName, layoutId }) => boardName === expectedLayout.boardName && layoutId === expectedLayout.layoutId,
      );
      expect(image).toMatchObject(expectedLayout);
      expect(image?.setIds).toEqual(
        getBoardSetsForLayoutAndSize(expectedLayout.boardName, expectedLayout.layoutId, expectedLayout.sizeId).map(
          (holdSet) => holdSet.id,
        ),
      );
    }
  });

  it.each(EXPECTED_LAYOUTS)(
    'decodes and verifies the art provenance for $boardName/$layoutId',
    async ({ boardName, layoutId }) => {
      const image = manifest.layouts.find((layout) => layout.boardName === boardName && layout.layoutId === layoutId);
      expect(image).toBeDefined();
      if (!image) throw new Error(`Missing gallery image: ${boardName}/${layoutId}`);
      const imageBytes = await readFile(join(PUBLIC_ROOT, image.src.slice(1)));
      expect(imageBytes.byteLength).toBe(image.bytes);
      expect(sha256(imageBytes)).toBe(image.sha256);
      expect(image.src).toBe(`/images/board-gallery/${boardName}-${layoutId}-${image.sha256.slice(0, 12)}.webp`);
      const metadata = await sharp(imageBytes).metadata();
      expect(metadata.format).toBe('webp');
      const decodedImage = await sharp(imageBytes).raw().toBuffer({ resolveWithObject: true });
      expect(decodedImage.info.width).toBe(480);
      expect(decodedImage.info.width).toBe(image.width);
      expect(decodedImage.info.height).toBe(image.height);
      expect(decodedImage.data.byteLength).toBe(image.width * image.height * decodedImage.info.channels);
      expect(image.sourceLayers.length).toBeGreaterThan(0);
      expect(new Set(image.sourceLayers.map((layer) => layer.path)).size).toBe(image.sourceLayers.length);
      for (const sourceLayer of image.sourceLayers) {
        const sourceBytes = await readFile(join(PUBLIC_ROOT, sourceLayer.path));
        expect(sha256(sourceBytes), sourceLayer.path).toBe(sourceLayer.sha256);
      }
    },
  );
});
