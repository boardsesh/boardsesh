import type { BoardName } from '@boardsesh/shared-schema';
import { STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { HoldPlacement } from '../board-renderer/types';

/**
 * The boards the rendering spike draws (issue #2202).
 *
 * Chosen for visually distinct hold sets rather than for coverage: Tension's
 * wooden originals against TB2's plastic, Kilter's Homewall against the
 * commercial Original, and two MoonBoards whose art is drawn for a white wall.
 * Whatever a halo treatment does, it has to survive all of these.
 */
export type SpikeBoardConfig = {
  key: string;
  label: string;
  /** One line on what makes this board's art awkward. */
  note: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

export const SPIKE_BOARDS: readonly SpikeBoardConfig[] = [
  {
    key: 'grasshopper-master',
    label: 'Grasshopper Master 8x12',
    note: 'The board the issue was filed against. Dense, low-contrast art with bright blue set holds.',
    boardName: 'grasshopper',
    layoutId: 1,
    sizeId: 5,
    setIds: [1, 2, 3, 4, 6],
  },
  {
    key: 'tension-classic',
    label: 'Tension Original Full Wall',
    note: 'Wooden holds, warm and low-contrast against a dark field, plus a separate foot set.',
    boardName: 'tension',
    layoutId: 9,
    sizeId: 1,
    setIds: [8, 9, 10, 11],
  },
  {
    key: 'tension-mirror-12x12',
    label: 'Tension Board 2 Mirror 12x12',
    note: 'Wood and plastic in one layout — the plastic set is far lighter than the wood.',
    boardName: 'tension',
    layoutId: 10,
    sizeId: 6,
    setIds: [12, 13],
  },
  {
    key: 'kilter-homewall-10x12',
    label: 'Kilter Homewall 10x12',
    note: 'Four layers including kickboard sets; the auxiliary holds are much smaller than mainline.',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: [26, 27, 28, 29],
  },
  {
    key: 'kilter-original-12x12',
    label: 'Kilter Original 12x12',
    note: 'Big colourful bolt-ons next to tiny screw-ons — the widest size range of any board here.',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: [1, 20],
  },
  {
    key: 'moonboard-2016',
    label: 'MoonBoard 2016',
    note: 'Art drawn for a white wall, on a fixed grid: most cells have no hold at all.',
    boardName: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: [2, 3, 4],
  },
  {
    key: 'moonboard-masters-2019',
    label: 'MoonBoard Masters 2019',
    note: 'Wooden holds mixed with plastic, and no foot role — start, hand and finish only.',
    boardName: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: [17, 18, 21],
  },
];

export const DEFAULT_SPIKE_BOARD_KEY = 'grasshopper-master';

/**
 * Where a synthesised climb puts each role, as fractions of the board box with
 * the origin top-left. A left-trending hand line with a start pair low and a
 * finish at the top — a shape that exists on every board, so one description
 * works for all of them and the boards stay comparable.
 */
const CLIMB_TARGETS: ReadonlyArray<{ role: 'STARTING' | 'HAND' | 'FINISH' | 'FOOT'; x: number; y: number }> = [
  { role: 'STARTING', x: 0.42, y: 0.82 },
  { role: 'STARTING', x: 0.58, y: 0.8 },
  { role: 'HAND', x: 0.34, y: 0.68 },
  { role: 'HAND', x: 0.55, y: 0.58 },
  { role: 'HAND', x: 0.38, y: 0.47 },
  { role: 'HAND', x: 0.62, y: 0.37 },
  { role: 'HAND', x: 0.46, y: 0.27 },
  { role: 'HAND', x: 0.66, y: 0.19 },
  { role: 'HAND', x: 0.5, y: 0.12 },
  { role: 'FINISH', x: 0.54, y: 0.06 },
  { role: 'FOOT', x: 0.26, y: 0.9 },
  { role: 'FOOT', x: 0.72, y: 0.92 },
  { role: 'FOOT', x: 0.28, y: 0.76 },
  { role: 'FOOT', x: 0.76, y: 0.74 },
  { role: 'FOOT', x: 0.42, y: 0.66 },
  { role: 'FOOT', x: 0.6, y: 0.62 },
];

/**
 * Build a plausible climb for a board out of its own placements: for each
 * target, take the nearest placement not already used.
 *
 * Synthesised rather than pulled from the catalogue so the spike needs no
 * network, no login and no seeded database, and so every board shows the same
 * shape of climb — which is the only way the boards are comparable to each
 * other. A board with no FOOT code in `STATE_TO_PRIMARY_CODE` (MoonBoard)
 * simply skips those targets.
 */
export function synthesiseSpikeFrames(
  boardName: BoardName,
  holdsData: HoldPlacement[],
  boardWidth: number,
  boardHeight: number,
): string {
  const roleCodes = STATE_TO_PRIMARY_CODE[boardName] ?? {};
  const used = new Set<number>();
  const tokens: string[] = [];

  for (const target of CLIMB_TARGETS) {
    const roleCode = roleCodes[target.role];
    if (roleCode === undefined) continue;
    const targetX = target.x * boardWidth;
    const targetY = target.y * boardHeight;

    let best: HoldPlacement | null = null;
    let bestDistance = Infinity;
    for (const placement of holdsData) {
      if (used.has(placement.id)) continue;
      const distance = (placement.cx - targetX) ** 2 + (placement.cy - targetY) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = placement;
      }
    }
    if (best === null) continue;
    used.add(best.id);
    tokens.push(`p${best.id}r${roleCode}`);
  }

  return tokens.join('');
}
