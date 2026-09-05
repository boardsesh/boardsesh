/**
 * Rebuild Woods placement centres and physical-hold ownership from reviewed
 * board-art calibration. No network, database or Python dependencies.
 *
 * vp run generate:woods-hold-positions
 * vp run check:woods-hold-positions
 * vp run generate:woods-hold-positions -- --report=/tmp/woods-positions
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { buildWhiteKeyMask } from '../packages/shared/board-art-geometry/src/segmentation/white-key';
import { WOODS_ROW_LENGTHS } from '../packages/shared/board-config/src/woods-config';
import { WOODS_ART_CALIBRATION, type WoodsArtCalibration } from './woods-board-calibration';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'packages/board-constants/src/generated/woods-hold-positions-data.ts');

export function calibratedWoodsPositions(calibration: WoodsArtCalibration) {
  if (calibration.rowY.length !== calibration.occupiedRows.length) throw new Error('Woods row counts disagree');
  const positions: Record<number, readonly [number, number]> = {};
  const occupiedHoldIds: number[] = [];
  let placementId = 0;
  for (const [rowIndex, occupiedRow] of calibration.occupiedRows.entries()) {
    if (!/^[01]+$/.test(occupiedRow)) throw new Error(`Invalid Woods occupancy row ${rowIndex}`);
    const sparse = occupiedRow.length < calibration.denseColumns;
    const sparseColumns = (calibration.denseColumns + 1) / 2;
    if (![calibration.denseColumns, sparseColumns, sparseColumns - 1].includes(occupiedRow.length)) {
      throw new Error(`Invalid Woods row length at row ${rowIndex}`);
    }
    const inset = sparse && occupiedRow.length === sparseColumns - 1 ? calibration.columnPitch : 0;
    const pitch = calibration.columnPitch * (sparse ? 2 : 1);
    for (let column = 0; column < occupiedRow.length; column += 1) {
      const x = calibration.firstColumn + inset + column * pitch;
      const y = calibration.rowY[rowIndex];
      if (x < 0 || x >= calibration.width || y < 0 || y >= calibration.height) {
        throw new Error(`Woods placement ${placementId} escapes the art`);
      }
      positions[placementId] = [
        Number((x / calibration.width).toFixed(5)),
        Number((y / calibration.height).toFixed(5)),
      ];
      if (occupiedRow[column] === '1') occupiedHoldIds.push(placementId);
      placementId += 1;
    }
  }
  return { positions, occupiedHoldIds };
}

async function main() {
  const check = process.argv.includes('--check');
  const reportArgument = process.argv.find((argument) => argument.startsWith('--report='));
  const reportDirectory = reportArgument?.slice('--report='.length);
  const positionBlocks: string[] = [];
  const ownershipBlocks: string[] = [];
  for (const [size, calibration] of Object.entries(WOODS_ART_CALIBRATION)) {
    const expectedRows = WOODS_ROW_LENGTHS[size as keyof typeof WOODS_ROW_LENGTHS];
    if (
      calibration.occupiedRows.length !== expectedRows.length ||
      calibration.occupiedRows.some((row, index) => row.length !== expectedRows[index])
    ) {
      throw new Error(`Woods ${size} row lengths would change existing placement IDs`);
    }
    const source = readFileSync(path.join(ROOT, `packages/web/public/images/woods/woods-${size}-bg.png`));
    if (createHash('sha256').update(source).digest('hex') !== calibration.imageSha256) {
      throw new Error(`Woods ${size} art changed; review its calibration before regenerating`);
    }
    const { data: pixels, info: dimensions } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (dimensions.width !== calibration.width || dimensions.height !== calibration.height) {
      throw new Error(`Woods ${size} image dimensions disagree with its calibration`);
    }
    const { positions, occupiedHoldIds } = calibratedWoodsPositions(calibration);
    const { mask } = buildWhiteKeyMask(pixels, dimensions.width, dimensions.height, dimensions.channels);
    for (const placementId of occupiedHoldIds) {
      const [x, y] = positions[placementId];
      const centreX = Math.round(x * calibration.width);
      const centreY = Math.round(y * calibration.height);
      let substance = 0;
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const sampleX = centreX + dx;
          const sampleY = centreY + dy;
          if (sampleX >= 0 && sampleX < calibration.width && sampleY >= 0 && sampleY < calibration.height) {
            substance += mask[sampleY * calibration.width + sampleX];
          }
        }
      }
      if (substance === 0) throw new Error(`Woods ${size} occupied placement ${placementId} sits on bare wall`);
    }
    positionBlocks.push(
      `  '${size}': {\n${Object.entries(positions)
        .map(([id, position]) => `    ${id}: [${position.join(', ')}],`)
        .join('\n')}\n  },`,
    );
    ownershipBlocks.push(
      `  '${size}': [\n${occupiedHoldIds
        .reduce<string[]>((lines, placementId, index) => {
          if (index === 0 || lines[lines.length - 1].length + String(placementId).length + 1 > 120) lines.push('    ');
          lines[lines.length - 1] += `${placementId}, `;
          return lines;
        }, [])
        .map((line) => line.trimEnd())
        .join('\n')}\n  ],`,
    );
    if (reportDirectory) {
      mkdirSync(reportDirectory, { recursive: true });
      const occupied = new Set(occupiedHoldIds);
      const marks = Object.entries(positions).map(([id, [x, y]]) => {
        const cx = x * calibration.width;
        const cy = y * calibration.height;
        const colour = occupied.has(Number(id)) ? '#007a25' : '#d00000';
        return `<circle cx="${cx}" cy="${cy}" r="4" fill="none" stroke="${colour}"/><text x="${cx + 4}" y="${cy - 4}" font-size="8" fill="${colour}">${id}</text>`;
      });
      const overlay = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${calibration.width}" height="${calibration.height}">${marks.join('')}</svg>`,
      );
      await sharp(source)
        .composite([{ input: overlay }])
        .png()
        .toFile(path.join(reportDirectory, `${size}.png`));
    }
    console.log(`Woods ${size}: ${Object.keys(positions).length} slots, ${occupiedHoldIds.length} physical holds`);
  }
  const output = `/**
 * Generated by vp run generate:woods-hold-positions. DO NOT EDIT.
 * Reviewed source: scripts/woods-board-calibration.ts (#4971).
 * Every logical slot keeps its baseHoldLocation, including empty slots.
 * Positions are normalized over the lossless Woods board-art image.
 */
export type WoodsBoardSize = '8x10' | '12x12';

export const WOODS_HOLD_POSITIONS: Record<WoodsBoardSize, Record<number, readonly [number, number]>> = {
${positionBlocks.join('\n')}
};

/** Physical holds only. Empty mounting slots must not seed silhouette tracing. */
export const WOODS_OCCUPIED_HOLD_IDS: Record<WoodsBoardSize, readonly number[]> = {
${ownershipBlocks.join('\n')}
};
`;
  if (check) {
    if (readFileSync(OUTPUT, 'utf8') !== output)
      throw new Error('Woods positions are stale; run vp run generate:woods-hold-positions');
  } else if (!reportDirectory) {
    writeFileSync(OUTPUT, output);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
