import sprayGeometry from './spray/geometry.json';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { getBoardRenderData } from '../../lib/board-details';
import { STORY_CLIMBS } from './climbs';
import recorded from '../../lib/board-render/fixtures/recorded-climbs.json';

export type StoryBoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};
export type StorySprayGeometry = {
  width: number;
  height: number;
  photoId: 'spray-liz' | 'spray-cherry' | 'spray-bowlo';
  holds: { id: number; cx: number; cy: number; r: number; outline: number[] | null }[];
};
export type StoryBoardFixture = { board: StoryBoardConfig; climbs: Climb[]; spray?: StorySprayGeometry };
const configurations: Record<string, StoryBoardConfig> = {
  decoy: {
    boardName: 'decoy',
    layoutId: 2,
    sizeId: 1,
    setIds: '2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20',
    angle: 40,
  },
  'kilter-original-12x12': {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
  },
  'kilter-homewall-7x10': {
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '26,27',
    angle: 40,
  },
  'kilter-homewall-10x10': {
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 21,
    setIds: '26,27',
    angle: 40,
  },
  'tension-2-mirror': {
    boardName: 'tension',
    layoutId: 10,
    sizeId: 6,
    setIds: '12,13',
    angle: 40,
  },
  'moonboard-2024': {
    boardName: 'moonboard',
    layoutId: 3,
    sizeId: 1,
    setIds: '5,6,7,8,9,10',
    angle: 40,
  },
  'woods-12x12': {
    boardName: 'woods',
    layoutId: 1,
    sizeId: 2,
    setIds: '1',
    angle: 40,
  },
  'tension-original': {
    boardName: 'tension',
    layoutId: 9,
    sizeId: 1,
    setIds: '8,9,10,11',
    angle: 40,
  },
  'tension-2-spray': {
    boardName: 'tension',
    layoutId: 11,
    sizeId: 6,
    setIds: '12,13',
    angle: 40,
  },
  'moonboard-2016': {
    boardName: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '2,3,4',
    angle: 40,
  },
  'moonboard-2019': {
    boardName: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: '17,18,19,20,21,22,23',
    angle: 40,
  },
  grasshopper: {
    boardName: 'grasshopper',
    layoutId: 1,
    sizeId: 4,
    setIds: '1,2,3,4,5,6',
    angle: 40,
  },
};

/** Deterministic mock problem using real catalogue placements, for layouts absent from the recording. */
function mockClimb(board: StoryBoardConfig): Climb {
  const geometry = getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
  if (!geometry?.holdsData.length)
    throw new Error(`No geometry for story board ${board.boardName}/${board.layoutId}/${board.sizeId}`);
  const roles = HOLD_STATE_MAP[board.boardName];
  const code = (name: string) => Number(Object.entries(roles).find(([, role]) => role.name === name)?.[0]);
  const used = new Set<number>();
  const targets = [
    [0.4, 0.8],
    [0.6, 0.8],
    [0.3, 0.65],
    [0.65, 0.5],
    [0.4, 0.35],
    [0.6, 0.15],
  ];
  const frames = targets
    .map(([x, y], index) => {
      const targetX = x * geometry.boardWidth;
      const targetY = y * geometry.boardHeight;
      const hold = geometry.holdsData
        .filter((candidate) => !used.has(candidate.id))
        .reduce((nearest, candidate) =>
          Math.hypot(candidate.cx - targetX, candidate.cy - targetY) <
          Math.hypot(nearest.cx - targetX, nearest.cy - targetY)
            ? candidate
            : nearest,
        );
      used.add(hold.id);
      return `p${hold.id}r${code(index < 2 ? 'STARTING' : index === targets.length - 1 ? 'FINISH' : 'HAND')}`;
    })
    .join('');
  return {
    ...STORY_CLIMBS[0],
    uuid: `story-${board.boardName}-${board.layoutId}-${board.sizeId}`,
    name: 'Morning circuit',
    frames,
    boardType: board.boardName,
    layoutId: board.layoutId,
    angle: board.angle,
  };
}
function buildFixture(board: StoryBoardConfig): StoryBoardFixture {
  const samples = recorded[`${board.boardName}-${board.layoutId}` as keyof typeof recorded];
  const geometry = getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
  const placements = new Set(geometry?.holdsData.map((hold) => hold.id));
  const compatible = samples?.filter((climb) => {
    const markers = [...climb.frames.matchAll(/p(\d+)r(\d+)/g)];
    return (
      markers.length > 0 &&
      markers.every(
        (marker) =>
          placements.has(Number(marker[1])) && HOLD_STATE_MAP[board.boardName][Number(marker[2])] !== undefined,
      )
    );
  });
  return { board, climbs: compatible?.length ? compatible : [mockClimb(board)] };
}
export const STORY_BOARDS: Record<string, StoryBoardFixture> = Object.fromEntries(
  Object.entries(configurations).map(([id, board]) => [id, buildFixture(board)]),
);
for (const [alias, id] of Object.entries({
  kilter: 'kilter-original-12x12',
  tension: 'tension-2-mirror',
  moonboard: 'moonboard-2016',
  woods: 'woods-12x12',
}))
  STORY_BOARDS[alias] = STORY_BOARDS[id];

for (const id of ['spray-liz', 'spray-cherry', 'spray-bowlo'] as const) {
  const source = sprayGeometry[id];
  const board: StoryBoardConfig = {
    boardName: 'spray',
    layoutId: source.layoutId,
    sizeId: source.layoutId,
    setIds: '1',
    angle: 40,
  };
  STORY_BOARDS[id] = {
    board,
    spray: { width: source.width, height: source.height, holds: source.holds, photoId: id },
    climbs: source.climbs.map((climb) => ({
      ...STORY_CLIMBS[0],
      ...climb,
      boardType: 'spray',
      layoutId: source.layoutId,
      angle: 40,
      framesCount: 1,
    })),
  };
}
STORY_BOARDS.spray = STORY_BOARDS['spray-liz'];
