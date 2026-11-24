import { describe, expect, it } from 'vitest';
import type { GymKioskBoard } from '@boardsesh/shared-schema';
import { buildKioskViewModel } from '../kiosk-view-model';

function makeBoard(boardUuid: string, boardId: number): GymKioskBoard {
  return {
    boardId,
    boardUuid,
    slug: `board-${boardId}`,
    name: `Board ${boardId}`,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    angle: 40,
  };
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';

function layoutFor(boardUuids: string[], leaderboard: { boardUuid: string | null; period: string } | null = null) {
  return {
    version: 1,
    boards: boardUuids.map((boardUuid) => ({ boardUuid })),
    leaderboard,
  };
}

describe('buildKioskViewModel', () => {
  it('passes the saved theme to the renderer and defaults legacy or malformed themes to dark', () => {
    expect(buildKioskViewModel({ layout: layoutFor([]), boards: [] }).theme).toBe('dark');
    expect(buildKioskViewModel({ layout: { ...layoutFor([]), theme: 'light' }, boards: [] }).theme).toBe('light');
    expect(buildKioskViewModel({ layout: { ...layoutFor([]), theme: 'invalid' }, boards: [] }).theme).toBe('dark');
  });

  it('derives the preset from the RESOLVED board count', () => {
    const boards = [makeBoard(UUID_A, 1), makeBoard(UUID_B, 2)];
    const viewModel = buildKioskViewModel({ layout: layoutFor([UUID_A, UUID_B]), boards });
    expect(viewModel.preset).toBe('dual');
    expect(viewModel.boards).toBe(boards);
  });

  it('degrades quad to triple when the backend omitted one slot board', () => {
    // Four slots in the stored layout, but only three survive resolution
    // (one board is non-public and the viewer is anonymous).
    const boards = [makeBoard(UUID_A, 1), makeBoard(UUID_B, 2), makeBoard(UUID_C, 3)];
    const viewModel = buildKioskViewModel({ layout: layoutFor([UUID_A, UUID_B, UUID_C, UUID_D]), boards });
    expect(viewModel.preset).toBe('triple');
  });

  it('yields a null preset (setup placeholder) with zero resolved boards', () => {
    const viewModel = buildKioskViewModel({ layout: layoutFor([UUID_A]), boards: [] });
    expect(viewModel.preset).toBeNull();
  });

  it('passes the leaderboard config through when its scope board is resolved', () => {
    const boards = [makeBoard(UUID_A, 1)];
    const viewModel = buildKioskViewModel({
      layout: layoutFor([UUID_A], { boardUuid: UUID_A, period: 'week' }),
      boards,
    });
    expect(viewModel.leaderboard).toEqual({ boardUuid: UUID_A, period: 'week' });
  });

  it('widens a leaderboard scoped to a viewer-hidden board to all boards', () => {
    // UUID_B is in the layout (so the lenient parser keeps the scope) but was
    // omitted from the resolved list — the rail widens instead of ranking an
    // invisible wall.
    const boards = [makeBoard(UUID_A, 1)];
    const viewModel = buildKioskViewModel({
      layout: layoutFor([UUID_A, UUID_B], { boardUuid: UUID_B, period: 'session' }),
      boards,
    });
    expect(viewModel.leaderboard).toEqual({ boardUuid: null, period: 'session' });
  });

  it('keeps the rail scope aligned with the boards that actually render', () => {
    // The renderer passes its detail-FILTERED slot list as `boards`: UUID_B
    // resolved server-side but its board details failed client-side, so it is
    // off the grid and off the presence hub. The rail must not scope to it
    // (its session history would always be empty and silently bias the
    // ranking) — the scope widens to the rendered boards instead, and the
    // preset degrades in the same breath.
    const renderedBoards = [makeBoard(UUID_A, 1), makeBoard(UUID_C, 3)];
    const viewModel = buildKioskViewModel({
      layout: layoutFor([UUID_A, UUID_B, UUID_C], { boardUuid: UUID_B, period: 'week' }),
      boards: renderedBoards,
    });
    expect(viewModel.leaderboard).toEqual({ boardUuid: null, period: 'week' });
    expect(viewModel.preset).toBe('dual');
    expect(viewModel.boards).toBe(renderedBoards);
  });

  it('keeps the rail off when the layout has no leaderboard', () => {
    const viewModel = buildKioskViewModel({ layout: layoutFor([UUID_A]), boards: [makeBoard(UUID_A, 1)] });
    expect(viewModel.leaderboard).toBeNull();
  });

  it('propagates showInstallQr from the layout (default false when absent)', () => {
    const boards = [makeBoard(UUID_A, 1)];
    expect(buildKioskViewModel({ layout: layoutFor([UUID_A]), boards }).showInstallQr).toBe(false);
    expect(buildKioskViewModel({ layout: { ...layoutFor([UUID_A]), showInstallQr: true }, boards }).showInstallQr).toBe(
      true,
    );
  });

  it('tolerates a corrupt layout (rail dropped, boards still render)', () => {
    const boards = [makeBoard(UUID_A, 1)];
    const viewModel = buildKioskViewModel({ layout: 'not json at all', boards });
    expect(viewModel.leaderboard).toBeNull();
    expect(viewModel.preset).toBe('single');
  });
});
