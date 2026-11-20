import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getBoardSetsForLayoutAndSize } from '@boardsesh/board-config';
import { getBoardImageDetailsForBoard } from '@boardsesh/board-config/image-metadata';
import { getBackgroundRelPaths, resolveArtPath, type RenderableBoardDetails } from '@boardsesh/board-render';
import { composeBoardBaseBuffer } from '@boardsesh/board-render/pipeline';
import { getLargestGalleryBoardSize, getOrderedGalleryLayouts } from '../app/boards/board-gallery-config';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const publicRoot = join(repositoryRoot, 'packages/web/public');
const outputDirectory = join(publicRoot, 'images/board-gallery');
const outputWidth = 480;
const resolveImagePath = (relativePath: string): string | null => {
  const filename = join(publicRoot, relativePath);
  return existsSync(filename) ? filename : null;
};
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function generateGallery() {
  await mkdir(outputDirectory, { recursive: true });
  const layouts = [];
  for (const boardName of SUPPORTED_BOARDS) {
    if (boardName === 'spray') continue;
    for (const layout of getOrderedGalleryLayouts(boardName)) {
      const size = getLargestGalleryBoardSize(boardName, layout.id);
      const sizeId = size.id;
      const setIds = getBoardSetsForLayoutAndSize(boardName, layout.id, sizeId).map((set) => set.id);
      if (setIds.length === 0) throw new Error(`No hold sets for ${boardName}/${layout.id}/${sizeId}`);
      const details = getBoardImageDetailsForBoard({
        board_name: boardName,
        layout_id: layout.id,
        size_id: sizeId,
        set_ids: setIds,
      });
      // This is the backend's photo/hold composition, with no climb overlay.
      const renderDetails: RenderableBoardDetails = {
        ...details,
        images_to_holds: Object.fromEntries(details.backgroundImagePaths.map((filename) => [filename, []])),
        holdsData: [],
      };
      // Matches the web's production dark-art choice; other boards keep their original art.
      const colorScheme = boardName === 'woods' ? 'dark' : 'light';
      const sourceLayers = [];
      for (const relativePath of getBackgroundRelPaths(renderDetails, false, colorScheme)) {
        const filename = resolveArtPath(relativePath, resolveImagePath);
        if (!filename) throw new Error(`Missing gallery source: ${relativePath}`);
        sourceLayers.push({ path: filename.slice(publicRoot.length + 1), sha256: sha256(await readFile(filename)) });
      }
      const height = Math.round((outputWidth * details.boardHeight) / details.boardWidth);
      const pixels = await composeBoardBaseBuffer({
        boardDetails: renderDetails,
        width: outputWidth,
        height,
        thumbnail: false,
        dimBackground: 0,
        resolveImagePath,
        colorScheme,
      });
      if (!pixels) throw new Error(`No board art composed for ${boardName}/${layout.id}`);
      const image = await sharp(pixels, { raw: { width: outputWidth, height, channels: 4 } })
        .webp({ quality: 86, alphaQuality: 90, effort: 4 })
        .toBuffer();
      const imageHash = sha256(image);
      const filename = `${boardName}-${layout.id}-${imageHash.slice(0, 12)}.webp`;
      await writeFile(join(outputDirectory, filename), image);
      layouts.push({
        boardName,
        layoutId: layout.id,
        layoutName: layout.name,
        sizeId,
        sizeName: size.name,
        physicalWidth: size.edgeRight - size.edgeLeft,
        physicalHeight: size.edgeTop - size.edgeBottom,
        setIds,
        src: `/images/board-gallery/${filename}`,
        width: outputWidth,
        height,
        sha256: imageHash,
        bytes: image.length,
        sourceLayers,
      });
      console.log(`${boardName}/${layout.id}: ${outputWidth}×${height}, ${image.length} bytes`);
    }
  }
  await writeFile(
    join(repositoryRoot, 'packages/web/app/boards/board-gallery-manifest.json'),
    `${JSON.stringify({ renderer: 'composeBoardBaseBuffer', width: outputWidth, layouts }, null, 2)}\n`,
  );
  console.log(`Generated ${layouts.length} real board-layout images.`);
}

void generateGallery().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
