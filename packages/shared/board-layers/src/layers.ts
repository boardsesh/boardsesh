// The subpath, not the package root: tests across the app replace the root
// `@boardsesh/board-config` module with a few stubs, and these limits are read
// when this module loads.
import { getBoardCapabilities, LAYERED_WALL_BOARD_NAMES } from '@boardsesh/board-config/capabilities';

const layeredWallCapabilities = LAYERED_WALL_BOARD_NAMES.map((boardName) => getBoardCapabilities(boardName));

/** Most climbs any board's controller keeps lit at once, one per layer. */
export const MAX_ACTIVE_BOARD_LAYERS = Math.max(
  1,
  ...layeredWallCapabilities.map(({ maxActiveWallClimbs }) => maxActiveWallClimbs),
);

/** Most distinct lights one layer can hold on any layered board. This is a
 * maximum over boards, so a layered board with a null cap would still parse at
 * the largest other board's cap; the board-config capability test stops that by
 * requiring a cap above 0 on every layered board. */
export const MAX_DIODES_PER_LAYER = Math.max(
  0,
  ...layeredWallCapabilities.map(({ maxLightsPerWallClimb }) => maxLightsPerWallClimb ?? 0),
);

/** Most distinct placements a full roster of layers can light: the bound on the
 * occupied placement ids one climb search may carry. The product of the two
 * maxima, so it admits every roster the limits above accept. */
export const MAX_OCCUPIED_PLACEMENTS = MAX_ACTIVE_BOARD_LAYERS * MAX_DIODES_PER_LAYER;

export const BOARD_LAYER_COLORS = [
  { key: 'green', red: 0, green: 255, blue: 0, hex: '#00FF00' },
  { key: 'cyan', red: 0, green: 255, blue: 255, hex: '#00FFFF' },
  { key: 'magenta', red: 255, green: 0, blue: 255, hex: '#FF00FF' },
  { key: 'yellow', red: 255, green: 255, blue: 0, hex: '#FFFF00' },
] as const;

export type BoardLayerColorKey = (typeof BOARD_LAYER_COLORS)[number]['key'];
export type BoardLayerColor = (typeof BOARD_LAYER_COLORS)[number];
