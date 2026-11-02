// Owner decision A: what the MiniPlayer's bulb is on the climber's last pick.
// Lit only through a live link, so the bar's usual bulb (whose disconnected tap
// connects, and the connect lights the QUEUE'S current climb) never stands for
// a pick that presence alone says is up; a climb no board here can light gets
// no bulb, as the player offers no board control for it.
import { describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';

// The pure resolver only: the hooks' modules are stubbed so nothing native loads.
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ boardConfig: null }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/graphql/hooks/use-gym-boards', () => ({ useGymBoards: () => ({ data: undefined }) }));
vi.mock('../../ble/use-board-connection-state', () => ({ useBoardConnectionState: () => ({}) }));
vi.mock('../../play-drawer/use-wall-climb', () => ({ useWallClimb: () => ({ uuid: null }) }));
// A climb on another board model draws on its own board, as the player resolves it.
vi.mock('../../../lib/boards/climb-render-board', () => ({
  resolveClimbRenderBoard: (
    climb: { boardType?: string; layoutId?: number },
    board: { boardName: string; layoutId: number },
  ) =>
    climb.boardType && climb.boardType !== board.boardName
      ? {
          boardConfig: { boardName: climb.boardType, layoutId: climb.layoutId, sizeId: 1, setIds: '1', angle: 40 },
          fit: 'incompatible',
          incompatible: true,
        }
      : { boardConfig: board, fit: 'exact', incompatible: false },
}));

import { resolvePickBulb, type PickBulbInputs } from '../use-pick-bulb';
import type { LastPick } from '../../../lib/last-pick-store';

const KILTER = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const ACTIVE_BOARD = { uuid: 'board-kilter', boardType: 'kilter', layoutId: 1 } as UserBoard;
const GYM_MOONBOARD = { uuid: 'board-moon', boardType: 'moonboard', layoutId: 2, name: 'Back room' } as UserBoard;

function pick(climb: Record<string, unknown> = {}, over: Partial<LastPick> = {}): LastPick {
  return {
    item: { uuid: 'queue-pick', climb: { uuid: 'pick', name: 'The Eyes', ...climb } } as unknown as ClimbQueueItem,
    suggestionSource: null,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick: 'queue-current',
    wallAtPick: null,
    pickedAt: 0,
    generation: 0,
    ...over,
  };
}

function inputs(over: Partial<PickBulbInputs> = {}): PickBulbInputs {
  return {
    pick: pick(),
    linked: true,
    wallClimbUuid: null,
    activeBoardConfig: KILTER,
    activeBoard: ACTIVE_BOARD,
    gymBoards: [ACTIVE_BOARD],
    ...over,
  };
}

describe('resolvePickBulb', () => {
  it('is lit when the wall shows the pick over a live link', () => {
    expect(resolvePickBulb(inputs({ wallClimbUuid: 'pick' }))).toEqual({ kind: 'lit' });
  });

  // QA #147: an Aurora box keeps its LEDs after a disconnect, so presence may
  // name the pick with no link. The usual bulb would connect and light the
  // queue's current climb; the pick's Put on board goes through the player,
  // which lights the pick again (`on_wall_unlinked`).
  it('is Put on board when only presence says the pick is up, with no link', () => {
    expect(resolvePickBulb(inputs({ linked: false, wallClimbUuid: 'pick' }))).toEqual({
      kind: 'putOnBoard',
      gymBoardName: null,
    });
  });

  it('is Put on board while the wall shows another climb', () => {
    expect(resolvePickBulb(inputs({ wallClimbUuid: 'other' }))).toEqual({ kind: 'putOnBoard', gymBoardName: null });
  });

  it('names the board at this gym that draws a pick from another board', () => {
    const result = resolvePickBulb(
      inputs({ pick: pick({ boardType: 'moonboard', layoutId: 2 }), gymBoards: [ACTIVE_BOARD, GYM_MOONBOARD] }),
    );
    expect(result).toEqual({ kind: 'putOnBoard', gymBoardName: 'MoonBoard' });
  });

  it('offers nothing for a pick from a board no one can walk to', () => {
    expect(resolvePickBulb(inputs({ pick: pick({ boardType: 'moonboard', layoutId: 2 }) }))).toEqual({
      kind: 'none',
    });
  });

  // A logbook row opened on its own (other) board: the player shows its
  // switch-board scrim there, with no board control.
  it('offers nothing for a pick opened on another board model', () => {
    const tension = { boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '1', angle: 40 };
    expect(
      resolvePickBulb(inputs({ pick: pick({ boardType: 'tension', layoutId: 9 }, { boardConfig: tension }) })),
    ).toEqual({ kind: 'none' });
  });

  // The same board at its own angle (a logbook row at 30°) is no other board.
  it('keeps Put on board for a pick opened on this board at another angle', () => {
    const atThirty = { ...KILTER, angle: 30 };
    expect(resolvePickBulb(inputs({ pick: pick({}, { boardConfig: atThirty }) }))).toEqual({
      kind: 'putOnBoard',
      gymBoardName: null,
    });
  });
});
