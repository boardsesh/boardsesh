/**
 * Script to generate hardcoded board data from the database.
 *
 * Usage:
 *   cd packages/web
 *   # Make sure postgres is running (bun run db:up)
 *   bunx tsx scripts/generate-size-edges.ts
 *
 * This generates app/lib/__generated__/product-sizes-data.ts
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';

// Load environment variables from .env.local
config({ path: join(__dirname, '../.env.local') });

const POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost';
const POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
const POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'password';
const POSTGRES_DATABASE = process.env.POSTGRES_DATABASE || 'main';

// Build psql command prefix
const psqlCmd = `PGPASSWORD=${POSTGRES_PASSWORD} psql -h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${POSTGRES_USER} -d ${POSTGRES_DATABASE}`;

const OUTPUT_PATH = join(__dirname, '../app/lib/__generated__/product-sizes-data.ts');
const LED_OUTPUT_PATH = join(__dirname, '../app/lib/__generated__/led-placements-data.ts');

interface ProductSize {
  id: number;
  name: string;
  description: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  productId: number;
}

interface Layout {
  id: number;
  name: string;
  productId: number;
}

interface SetMapping {
  setId: number;
  setName: string;
  layoutId: number;
  sizeId: number;
}

interface ImageFilenameMapping {
  layoutId: number;
  sizeId: number;
  setId: number;
  imageFilename: string;
}

interface LedPlacement {
  placementId: number;
  position: number;
  layoutId: number;
  sizeId: number;
}

interface HolePlacement {
  placementId: number;
  mirroredPlacementId: number | null;
  x: number;
  y: number;
  setId: number;
  layoutId: number;
}

function querySizes(boardName: string): ProductSize[] {
  // Use REPLACE to remove newlines from description, and use a unique record separator
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT id, REPLACE(name, E'\\n', ' '), COALESCE(REPLACE(description, E'\\n', ' '), ''), edge_left, edge_right, edge_bottom, edge_top, product_id FROM board_product_sizes WHERE board_type = '${boardName}' ORDER BY id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [id, name, description, edge_left, edge_right, edge_bottom, edge_top, product_id] = line.split('|');
      return {
        id: parseInt(id),
        name: name.trim(),
        description: description.trim(),
        edgeLeft: parseInt(edge_left),
        edgeRight: parseInt(edge_right),
        edgeBottom: parseInt(edge_bottom),
        edgeTop: parseInt(edge_top),
        productId: parseInt(product_id),
      };
    });
}

function queryLayouts(boardName: string): Layout[] {
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT id, REPLACE(name, E'\\n', ' '), product_id FROM board_layouts WHERE board_type = '${boardName}' AND is_listed = true AND password IS NULL ORDER BY id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [id, name, product_id] = line.split('|');
      return {
        id: parseInt(id),
        name: name.trim(),
        productId: parseInt(product_id),
      };
    });
}

function querySets(boardName: string): SetMapping[] {
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT sets.id, REPLACE(sets.name, E'\\n', ' '), psls.layout_id, psls.product_size_id FROM board_sets sets INNER JOIN board_product_sizes_layouts_sets psls ON sets.board_type = psls.board_type AND sets.id = psls.set_id WHERE sets.board_type = '${boardName}' ORDER BY psls.layout_id, psls.product_size_id, sets.id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [id, name, layout_id, size_id] = line.split('|');
      return {
        setId: parseInt(id),
        setName: name.trim(),
        layoutId: parseInt(layout_id),
        sizeId: parseInt(size_id),
      };
    });
}

function queryImageFilenames(boardName: string): ImageFilenameMapping[] {
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT layout_id, product_size_id, set_id, image_filename FROM board_product_sizes_layouts_sets WHERE board_type = '${boardName}' AND image_filename IS NOT NULL ORDER BY layout_id, product_size_id, set_id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [layout_id, size_id, set_id, image_filename] = line.split('|');
      return {
        layoutId: parseInt(layout_id),
        sizeId: parseInt(size_id),
        setId: parseInt(set_id),
        imageFilename: image_filename.trim(),
      };
    });
}

function queryLedPlacements(boardName: string): LedPlacement[] {
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT placements.id, leds.position, placements.layout_id, leds.product_size_id FROM board_placements placements INNER JOIN board_leds leds ON placements.board_type = leds.board_type AND placements.hole_id = leds.hole_id WHERE placements.board_type = '${boardName}' ORDER BY placements.layout_id, leds.product_size_id, placements.id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [placement_id, position, layout_id, size_id] = line.split('|');
      return {
        placementId: parseInt(placement_id),
        position: parseInt(position),
        layoutId: parseInt(layout_id),
        sizeId: parseInt(size_id),
      };
    });
}

function queryHolePlacements(boardName: string): HolePlacement[] {
  const result = execSync(
    `${psqlCmd} -t -A -F '|' -R '~~~' -c "SELECT placements.id, mirrored_placements.id, holes.x, holes.y, placements.set_id, placements.layout_id FROM board_holes holes INNER JOIN board_placements placements ON placements.board_type = holes.board_type AND placements.hole_id = holes.id LEFT JOIN board_placements mirrored_placements ON mirrored_placements.board_type = holes.board_type AND mirrored_placements.hole_id = holes.mirrored_hole_id AND mirrored_placements.set_id = placements.set_id AND mirrored_placements.layout_id = placements.layout_id WHERE holes.board_type = '${boardName}' ORDER BY placements.layout_id, placements.set_id, placements.id;"`,
    { encoding: 'utf-8' }
  );

  return result
    .trim()
    .split('~~~')
    .filter(line => line.length > 0 && !line.startsWith('\n'))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [placement_id, mirrored_id, x, y, set_id, layout_id] = line.split('|');
      return {
        placementId: parseInt(placement_id),
        mirroredPlacementId: mirrored_id ? parseInt(mirrored_id) : null,
        x: parseInt(x),
        y: parseInt(y),
        setId: parseInt(set_id),
        layoutId: parseInt(layout_id),
      };
    });
}

function escapeString(str: string): string {
  return str.replace(/'/g, "\\'");
}

function generateSizesTypeScript(boardName: string, sizes: ProductSize[]): string {
  const entries = sizes.map(s =>
    `    ${s.id}: { id: ${s.id}, name: '${escapeString(s.name)}', description: '${escapeString(s.description)}', edgeLeft: ${s.edgeLeft}, edgeRight: ${s.edgeRight}, edgeBottom: ${s.edgeBottom}, edgeTop: ${s.edgeTop}, productId: ${s.productId} },`
  ).join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateLayoutsTypeScript(boardName: string, layouts: Layout[]): string {
  const entries = layouts.map(l =>
    `    ${l.id}: { id: ${l.id}, name: '${escapeString(l.name)}', productId: ${l.productId} },`
  ).join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateSetsTypeScript(boardName: string, sets: SetMapping[]): string {
  // Group sets by layout_id-size_id key
  const grouped: Record<string, { id: number; name: string }[]> = {};
  for (const set of sets) {
    const key = `${set.layoutId}-${set.sizeId}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push({ id: set.setId, name: set.setName });
  }

  const entries = Object.entries(grouped)
    .map(([key, setList]) => {
      const setsArray = setList.map(s => `{ id: ${s.id}, name: '${escapeString(s.name)}' }`).join(', ');
      return `    '${key}': [${setsArray}],`;
    })
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateImageFilenamesTypeScript(boardName: string, mappings: ImageFilenameMapping[]): string {
  // Key by "layoutId-sizeId-setId"
  const entries = mappings
    .map(m => `    '${m.layoutId}-${m.sizeId}-${m.setId}': '${escapeString(m.imageFilename)}',`)
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateLedPlacementsTypeScript(boardName: string, placements: LedPlacement[]): string {
  // Group by "layoutId-sizeId" key, value is Record<placementId, position>
  const grouped: Record<string, Record<number, number>> = {};
  for (const p of placements) {
    const key = `${p.layoutId}-${p.sizeId}`;
    if (!grouped[key]) {
      grouped[key] = {};
    }
    grouped[key][p.placementId] = p.position;
  }

  const entries = Object.entries(grouped)
    .map(([key, ledMap]) => {
      const ledEntries = Object.entries(ledMap)
        .map(([placementId, position]) => `${placementId}: ${position}`)
        .join(', ');
      return `    '${key}': { ${ledEntries} },`;
    })
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateHolePlacementsTypeScript(boardName: string, placements: HolePlacement[]): string {
  // Group by "layoutId-setId" key, value is array of [placementId, mirroredId, x, y]
  const grouped: Record<string, [number, number | null, number, number][]> = {};
  for (const p of placements) {
    const key = `${p.layoutId}-${p.setId}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push([p.placementId, p.mirroredPlacementId, p.x, p.y]);
  }

  const entries = Object.entries(grouped)
    .map(([key, holds]) => {
      const holdsArray = holds.map(([id, mirrorId, x, y]) =>
        `[${id}, ${mirrorId === null ? 'null' : mirrorId}, ${x}, ${y}]`
      ).join(', ');
      return `    '${key}': [${holdsArray}],`;
    })
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

async function main() {
  console.log('Querying kilter product sizes...');
  const kilterSizes = querySizes('kilter');

  console.log('Querying tension product sizes...');
  const tensionSizes = querySizes('tension');

  console.log('Querying kilter layouts...');
  const kilterLayouts = queryLayouts('kilter');

  console.log('Querying tension layouts...');
  const tensionLayouts = queryLayouts('tension');

  console.log('Querying kilter sets...');
  const kilterSets = querySets('kilter');

  console.log('Querying tension sets...');
  const tensionSets = querySets('tension');

  console.log('Querying kilter image filenames...');
  const kilterImageFilenames = queryImageFilenames('kilter');

  console.log('Querying tension image filenames...');
  const tensionImageFilenames = queryImageFilenames('tension');

  console.log('Querying kilter LED placements...');
  const kilterLedPlacements = queryLedPlacements('kilter');

  console.log('Querying tension LED placements...');
  const tensionLedPlacements = queryLedPlacements('tension');

  console.log('Querying kilter hole placements...');
  const kilterHolePlacements = queryHolePlacements('kilter');

  console.log('Querying tension hole placements...');
  const tensionHolePlacements = queryHolePlacements('tension');

  const output = `/**
 * ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
 *
 * This file is auto-generated by running:
 *   bunx tsx scripts/generate-size-edges.ts
 *
 * Hardcoded board configuration data for each board type.
 * These values are static (board configurations don't change) so we hardcode them
 * to eliminate database queries.
 *
 * Includes: product sizes, layouts, sets, image filenames, hole placements.
 * LED placements are in a separate file (led-placements-data.ts) for code-splitting.
 *
 * Generated at: ${new Date().toISOString()}
 */

import { BoardName, BoardDetails, ImageFileName } from '@/app/lib/types';
import { BOARD_IMAGE_DIMENSIONS, SetIdList } from '@/app/lib/board-data';

export interface ProductSizeData {
  id: number;
  name: string;
  description: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  productId: number;
}

export interface LayoutData {
  id: number;
  name: string;
  productId: number;
}

export interface SetData {
  id: number;
  name: string;
}

export interface SizeEdges {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
}

// HoldTuple: [placementId, mirroredPlacementId | null, x, y]
export type HoldTuple = [number, number | null, number, number];

export const PRODUCT_SIZES: Record<BoardName, Record<number, ProductSizeData>> = {
${generateSizesTypeScript('kilter', kilterSizes)},
${generateSizesTypeScript('tension', tensionSizes)},
};

export const LAYOUTS: Record<BoardName, Record<number, LayoutData>> = {
${generateLayoutsTypeScript('kilter', kilterLayouts)},
${generateLayoutsTypeScript('tension', tensionLayouts)},
};

// Sets indexed by "layoutId-sizeId" key
export const SETS: Record<BoardName, Record<string, SetData[]>> = {
${generateSetsTypeScript('kilter', kilterSets)},
${generateSetsTypeScript('tension', tensionSets)},
};

// Image filenames indexed by "layoutId-sizeId-setId" key
export const IMAGE_FILENAMES: Record<BoardName, Record<string, string>> = {
${generateImageFilenamesTypeScript('kilter', kilterImageFilenames)},
${generateImageFilenamesTypeScript('tension', tensionImageFilenames)},
};

// Hole placements indexed by "layoutId-setId" key, value is array of HoldTuples
export const HOLE_PLACEMENTS: Record<BoardName, Record<string, HoldTuple[]>> = {
${generateHolePlacementsTypeScript('kilter', kilterHolePlacements)},
${generateHolePlacementsTypeScript('tension', tensionHolePlacements)},
};

/**
 * Get size edges for a given board and size ID.
 * Returns null if the size ID is not found.
 */
export const getSizeEdges = (boardName: BoardName, sizeId: number): SizeEdges | null => {
  const size = PRODUCT_SIZES[boardName]?.[sizeId];
  if (!size) return null;
  return {
    edgeLeft: size.edgeLeft,
    edgeRight: size.edgeRight,
    edgeBottom: size.edgeBottom,
    edgeTop: size.edgeTop,
  };
};

/**
 * Get full product size data for a given board and size ID.
 * Returns null if the size ID is not found.
 */
export const getProductSize = (boardName: BoardName, sizeId: number): ProductSizeData | null => {
  return PRODUCT_SIZES[boardName]?.[sizeId] ?? null;
};

/**
 * Get layout data for a given board and layout ID.
 * Returns null if the layout ID is not found.
 */
export const getLayout = (boardName: BoardName, layoutId: number): LayoutData | null => {
  return LAYOUTS[boardName]?.[layoutId] ?? null;
};

/**
 * Get all layouts for a given board.
 */
export const getAllLayouts = (boardName: BoardName): LayoutData[] => {
  const layouts = LAYOUTS[boardName];
  if (!layouts) return [];
  return Object.values(layouts);
};

/**
 * Get all sizes for a given board and layout ID.
 * Uses the layout's product_id to find matching sizes.
 */
export const getSizesForLayoutId = (boardName: BoardName, layoutId: number): ProductSizeData[] => {
  const layout = LAYOUTS[boardName]?.[layoutId];
  if (!layout) return [];
  const sizes = PRODUCT_SIZES[boardName];
  if (!sizes) return [];
  return Object.values(sizes).filter(size => size.productId === layout.productId);
};

/**
 * Get all sizes for a given board and product ID.
 * Used by the board selector to list available sizes.
 */
export const getSizesForProduct = (boardName: BoardName, productId: number): ProductSizeData[] => {
  const sizes = PRODUCT_SIZES[boardName];
  if (!sizes) return [];
  return Object.values(sizes).filter(size => size.productId === productId);
};

/**
 * Get all sets for a given board, layout, and size.
 */
export const getSetsForLayoutAndSize = (boardName: BoardName, layoutId: number, sizeId: number): SetData[] => {
  const key = \`\${layoutId}-\${sizeId}\`;
  return SETS[boardName]?.[key] ?? [];
};

/**
 * Default size IDs for each layout.
 * Used by the setup wizard to pre-select a sensible default.
 */
export const DEFAULT_SIZE_FOR_LAYOUT: Record<BoardName, Record<number, number>> = {
  kilter: {
    1: 10,  // Kilter Board Original -> 12 x 12 with kickboard
    8: 17,  // Kilter Board Homewall -> 7x10 Full Ride LED Kit
  },
  tension: {
    9: 1,   // Original Layout -> Full Wall (first size is fine)
    10: 8,  // Tension Board 2 Mirror -> 12 high x 8 wide
    11: 8,  // Tension Board 2 Spray -> 12 high x 8 wide
  },
};

/**
 * Get the default size ID for a given board and layout.
 * Falls back to the first available size if no default is defined.
 */
export const getDefaultSizeForLayout = (boardName: BoardName, layoutId: number): number | null => {
  const defaultSizeId = DEFAULT_SIZE_FOR_LAYOUT[boardName]?.[layoutId];
  if (defaultSizeId !== undefined) {
    return defaultSizeId;
  }
  // Fall back to first available size
  const sizes = getSizesForLayoutId(boardName, layoutId);
  return sizes.length > 0 ? sizes[0].id : null;
};

/**
 * Get all board selector options (layouts, sizes, sets) from hardcoded data.
 * This replaces the database query in getAllBoardSelectorOptions.
 */
export const getBoardSelectorOptions = () => {
  const boardNames: BoardName[] = ['kilter', 'tension'];

  const layouts: Record<BoardName, { id: number; name: string }[]> = {} as Record<BoardName, { id: number; name: string }[]>;
  const sizes: Record<string, { id: number; name: string; description: string }[]> = {};
  const sets: Record<string, { id: number; name: string }[]> = {};

  for (const boardName of boardNames) {
    // Get layouts
    layouts[boardName] = getAllLayouts(boardName).map(l => ({ id: l.id, name: l.name }));

    // Get sizes for each layout
    for (const layout of layouts[boardName]) {
      const layoutSizes = getSizesForLayoutId(boardName, layout.id);
      const sizeKey = \`\${boardName}-\${layout.id}\`;
      sizes[sizeKey] = layoutSizes.map(s => ({ id: s.id, name: s.name, description: s.description }));

      // Get sets for each size
      for (const size of layoutSizes) {
        const setKey = \`\${boardName}-\${layout.id}-\${size.id}\`;
        sets[setKey] = getSetsForLayoutAndSize(boardName, layout.id, size.id);
      }
    }
  }

  return { layouts, sizes, sets };
};

/**
 * Get image filename for a specific board configuration.
 * Returns null if not found.
 */
export const getImageFilename = (
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setId: number
): string | null => {
  const key = \`\${layoutId}-\${sizeId}-\${setId}\`;
  return IMAGE_FILENAMES[boardName]?.[key] ?? null;
};

/**
 * Get hole placements for a specific board layout and set.
 * Returns an array of HoldTuples: [placementId, mirroredPlacementId | null, x, y]
 */
export const getHolePlacements = (
  boardName: BoardName,
  layoutId: number,
  setId: number
): HoldTuple[] => {
  const key = \`\${layoutId}-\${setId}\`;
  return HOLE_PLACEMENTS[boardName]?.[key] ?? [];
};

// Helper type for hold render data
interface HoldRenderData {
  id: number;
  mirroredHoldId: number | null;
  cx: number;
  cy: number;
  r: number;
}

/**
 * Get complete board details from hardcoded data.
 * This is a fully synchronous function that requires no database queries.
 */
export const getBoardDetails = ({
  board_name,
  layout_id,
  size_id,
  set_ids,
}: {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
}): BoardDetails => {
  const sizeData = getProductSize(board_name, size_id);
  if (!sizeData) {
    throw new Error('Size dimensions not found');
  }

  const layoutData = getLayout(board_name, layout_id);
  const setsResult = getSetsForLayoutAndSize(board_name, layout_id, size_id);

  // Build images_to_holds map
  const imagesToHolds: Record<ImageFileName, HoldTuple[]> = {};
  for (const set_id of set_ids) {
    const imageFilename = getImageFilename(board_name, layout_id, size_id, set_id);
    if (!imageFilename) {
      throw new Error(\`Could not find image for set_id \${set_id} for layout_id: \${layout_id} and size_id: \${size_id}\`);
    }
    imagesToHolds[imageFilename] = getHolePlacements(board_name, layout_id, set_id);
  }

  const { edgeLeft: edge_left, edgeRight: edge_right, edgeBottom: edge_bottom, edgeTop: edge_top } = sizeData;

  const firstImage = Object.keys(imagesToHolds)[0];
  const dimensions = BOARD_IMAGE_DIMENSIONS[board_name][firstImage];
  const boardWidth = dimensions?.width ?? 1080;
  const boardHeight = dimensions?.height ?? 1920;

  const xSpacing = boardWidth / (edge_right - edge_left);
  const ySpacing = boardHeight / (edge_top - edge_bottom);

  const holdsData: HoldRenderData[] = Object.values(imagesToHolds).flatMap((holds: HoldTuple[]) =>
    holds
      .filter(([, , x, y]) => x > edge_left && x < edge_right && y > edge_bottom && y < edge_top)
      .map(([holdId, mirroredHoldId, x, y]) => ({
        id: holdId,
        mirroredHoldId,
        cx: (x - edge_left) * xSpacing,
        cy: boardHeight - (y - edge_bottom) * ySpacing,
        r: xSpacing * 4,
      })),
  );

  const selectedSets = setsResult.filter((s) => set_ids.includes(s.id));

  return {
    images_to_holds: imagesToHolds,
    holdsData,
    edge_left,
    edge_right,
    edge_bottom,
    edge_top,
    boardHeight,
    boardWidth,
    board_name,
    layout_id,
    size_id,
    set_ids,
    supportsMirroring: board_name === 'tension' && layout_id !== 11,
    layout_name: layoutData?.name,
    size_name: sizeData.name,
    size_description: sizeData.description,
    set_names: selectedSets.map((s) => s.name),
  };
};
`;

  console.log(`Writing to ${OUTPUT_PATH}...`);
  writeFileSync(OUTPUT_PATH, output, 'utf-8');

  // Generate separate LED placements file
  const ledOutput = `/**
 * ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
 *
 * This file is auto-generated by running:
 *   bunx tsx scripts/generate-size-edges.ts
 *
 * LED placement data for each board type.
 * This maps placement IDs to physical LED positions in the board's LED chain.
 * Only used by the bluetooth module for controlling board LEDs.
 *
 * Kept in a separate file to enable code-splitting - this data is only loaded
 * when the user actually needs to control the board via bluetooth.
 *
 * Generated at: ${new Date().toISOString()}
 */

import { BoardName } from '@/app/lib/types';

// LED placements indexed by "layoutId-sizeId" key, value is Record<placementId, ledPosition>
export const LED_PLACEMENTS: Record<BoardName, Record<string, Record<number, number>>> = {
${generateLedPlacementsTypeScript('kilter', kilterLedPlacements)},
${generateLedPlacementsTypeScript('tension', tensionLedPlacements)},
};

/**
 * Get LED placements for a specific board layout and size.
 * Returns a Record mapping placementId to LED position.
 */
export const getLedPlacements = (
  boardName: BoardName,
  layoutId: number,
  sizeId: number
): Record<number, number> => {
  const key = \`\${layoutId}-\${sizeId}\`;
  const placements = LED_PLACEMENTS[boardName]?.[key];
  if (!placements) {
    console.warn(
      \`[LED] No LED placements found for \${boardName} layout=\${layoutId} size=\${sizeId}. \` +
      \`Available keys: \${Object.keys(LED_PLACEMENTS[boardName] || {}).join(', ')}\`
    );
    return {};
  }
  return placements;
};
`;

  console.log(`Writing LED placements to ${LED_OUTPUT_PATH}...`);
  writeFileSync(LED_OUTPUT_PATH, ledOutput, 'utf-8');
  console.log('Done!');
}

main().catch(console.error);
