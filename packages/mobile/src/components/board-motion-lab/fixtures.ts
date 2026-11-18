/**
 * Boards and climb sets for the board motion lab. Every phone builds the same
 * climbs: the synthetic ones come from a seeded PRNG over the board's own hold
 * geometry, and the real ones are the recorded climbs the story harness uses.
 */
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import recordedClimbs from '../../lib/board-render/fixtures/recorded-climbs.json';
import type { LabBoard, LabClimb, LabClimbSet } from './types';

/** Own board list, so the lab never imports the story fixtures (and their 250 KB spray geometry). Spray walls are out: the GPU path excludes them. */
export const LAB_BOARDS: readonly LabBoard[] = [
  {
    id: 'kilter-homewall-7x10',
    label: 'Kilter Homewall 7x10',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '26,27',
    angle: 40,
  },
  {
    id: 'kilter-homewall-10x10',
    label: 'Kilter Homewall 10x10',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 21,
    setIds: '26,27',
    angle: 40,
  },
  {
    id: 'kilter-original-12x12',
    label: 'Kilter Original 12x12',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
  },
  {
    id: 'tension-2-mirror',
    label: 'Tension 2 Mirror',
    boardName: 'tension',
    layoutId: 10,
    sizeId: 6,
    setIds: '12,13',
    angle: 40,
  },
  {
    id: 'tension-original',
    label: 'Tension Original',
    boardName: 'tension',
    layoutId: 9,
    sizeId: 1,
    setIds: '8,9,10,11',
    angle: 40,
  },
  {
    id: 'moonboard-2024',
    label: 'MoonBoard 2024',
    boardName: 'moonboard',
    layoutId: 3,
    sizeId: 1,
    setIds: '5,6,7,8,9,10',
    angle: 40,
  },
  { id: 'woods-12x12', label: 'Woods 12x12', boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 },
  {
    id: 'grasshopper',
    label: 'Grasshopper',
    boardName: 'grasshopper',
    layoutId: 1,
    sizeId: 4,
    setIds: '1,2,3,4,5,6',
    angle: 40,
  },
];

export const DEFAULT_BOARD_ID = 'kilter-homewall-7x10';

export const SYNTHETIC_SET_KINDS = ['none', 'half', 'mostly', 'role-change'] as const;
export type SyntheticSetKind = (typeof SYNTHETIC_SET_KINDS)[number];

const SYNTHETIC_SETS: Record<SyntheticSetKind, { label: string; sharedRatio: number }> = {
  none: { label: 'No shared holds', sharedRatio: 0 },
  half: { label: 'Half shared', sharedRatio: 0.5 },
  mostly: { label: 'Mostly shared', sharedRatio: 0.9 },
  'role-change': { label: 'Shared holds change role', sharedRatio: 1 },
};

const CLIMBS_PER_SET = 6;
const MIN_REAL_CLIMBS = 4;

/** mulberry32: small, fast and identical on every JS engine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

type Band = 'start' | 'foot' | 'middle' | 'finish';
type PlacedHold = { id: number; band: Band };
type RoleCodes = Record<'STARTING' | 'HAND' | 'FOOT' | 'FINISH', number>;

function roleCodesFor(boardName: BoardName): RoleCodes {
  const entries = Object.entries(HOLD_STATE_MAP[boardName]);
  const codeFor = (name: string, fallback: number) => {
    const found = entries.find(([, role]) => role.name === name);
    return found ? Number(found[0]) : fallback;
  };
  const hand = codeFor('HAND', Number(entries[0]?.[0] ?? 0));
  return {
    STARTING: codeFor('STARTING', hand),
    HAND: hand,
    FOOT: codeFor('FOOT', hand),
    FINISH: codeFor('FINISH', hand),
  };
}

function bandOf(centerY: number, boardHeight: number): Band {
  // cy grows downward, so low holds have a large cy.
  const fromTop = centerY / boardHeight;
  if (fromTop > 0.8) return 'start';
  if (fromTop > 0.62) return 'foot';
  if (fromTop < 0.15) return 'finish';
  return 'middle';
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [copy[index], copy[swapWith]] = [copy[swapWith], copy[index]];
  }
  return copy;
}

function encodeFrames(holds: readonly PlacedHold[], codes: RoleCodes, swapHandAndFoot: boolean): string {
  return holds
    .map(({ id, band }) => {
      let role: keyof RoleCodes =
        band === 'start' ? 'STARTING' : band === 'finish' ? 'FINISH' : band === 'foot' ? 'FOOT' : 'HAND';
      if (swapHandAndFoot && role === 'HAND') role = 'FOOT';
      else if (swapHandAndFoot && role === 'FOOT') role = 'HAND';
      return `p${id}r${codes[role]}`;
    })
    .join('');
}

/** Deterministic climbs on `board`, each sharing about `sharedRatio` of its holds with the one before. */
export function buildSyntheticClimbs(board: LabBoard, kind: SyntheticSetKind): LabClimb[] {
  const geometry = getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
  if (!geometry?.holdsData.length) throw new Error(`No geometry for lab board ${board.id}`);
  const codes = roleCodesFor(board.boardName);
  const { label, sharedRatio } = SYNTHETIC_SETS[kind];
  const random = seededRandom(hashText(`${board.id}:${kind}`));

  const byBand: Record<Band, PlacedHold[]> = { start: [], foot: [], middle: [], finish: [] };
  for (const hold of geometry.holdsData) {
    const band = bandOf(hold.cy, geometry.boardHeight);
    byBand[band].push({ id: hold.id, band });
  }

  const groupSizes = (total: number): Record<Band, number> => {
    const start = 2;
    const finish = total > 10 ? 2 : 1;
    const foot = 2;
    return { start, finish, foot, middle: total - start - finish - foot };
  };

  const climbs: LabClimb[] = [];
  let previous: PlacedHold[] = [];
  for (let climbIndex = 0; climbIndex < CLIMBS_PER_SET; climbIndex += 1) {
    const total = 8 + Math.floor(random() * 5);
    const sizes = groupSizes(total);
    const previousIds = new Set(previous.map((hold) => hold.id));
    let holds: PlacedHold[] = [];
    if (kind === 'role-change' && previous.length > 0) {
      holds = previous;
    } else {
      for (const band of ['start', 'foot', 'middle', 'finish'] as const) {
        const wanted = sizes[band];
        const carried = shuffled(
          previous.filter((hold) => hold.band === band),
          random,
        ).slice(0, Math.round(wanted * sharedRatio));
        const fresh = shuffled(
          byBand[band].filter((hold) => !previousIds.has(hold.id)),
          random,
        ).slice(0, wanted - carried.length);
        holds.push(...carried, ...fresh);
      }
    }
    const swapRoles = kind === 'role-change' && climbIndex % 2 === 1;
    climbs.push({
      id: `${board.id}-${kind}-${climbIndex + 1}`,
      name: `${label} ${climbIndex + 1}`,
      frames: encodeFrames(holds, codes, swapRoles),
    });
    previous = holds;
  }
  return climbs;
}

function realClimbs(board: LabBoard): LabClimb[] {
  const samples = (recordedClimbs as Record<string, { uuid: string; name: string; frames: string }[]>)[
    `${board.boardName}-${board.layoutId}`
  ];
  const geometry = getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
  const placements = new Set(geometry?.holdsData.map((hold) => hold.id));
  const recorded: LabClimb[] = (samples ?? [])
    .filter((climb) => {
      const markers = [...climb.frames.matchAll(/p(\d+)r(\d+)/g)];
      return (
        markers.length > 0 &&
        markers.every(
          (marker) =>
            placements.has(Number(marker[1])) && HOLD_STATE_MAP[board.boardName][Number(marker[2])] !== undefined,
        )
      );
    })
    .map((climb) => ({ id: climb.uuid, name: climb.name, frames: climb.frames }));
  if (recorded.length >= MIN_REAL_CLIMBS) return recorded;
  const padding = buildSyntheticClimbs(board, 'half').slice(0, MIN_REAL_CLIMBS - recorded.length);
  return [...recorded, ...padding];
}

const climbSetCache = new Map<string, readonly LabClimbSet[]>();

/** The climb sets the lab offers on a board, "Real climbs" first. */
export function climbSetsFor(board: LabBoard): readonly LabClimbSet[] {
  const cached = climbSetCache.get(board.id);
  if (cached) return cached;
  const sets: LabClimbSet[] = [
    { id: 'real', label: 'Real climbs', climbs: realClimbs(board) },
    ...SYNTHETIC_SET_KINDS.map((kind) => ({
      id: kind,
      label: SYNTHETIC_SETS[kind].label,
      climbs: buildSyntheticClimbs(board, kind),
    })),
  ];
  climbSetCache.set(board.id, sets);
  return sets;
}

export function findLabBoard(id: string | null): LabBoard {
  return (
    LAB_BOARDS.find((board) => board.id === id) ??
    LAB_BOARDS.find((board) => board.id === DEFAULT_BOARD_ID) ??
    LAB_BOARDS[0]
  );
}
