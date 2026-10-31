// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import type { HoldPlacement } from '../../board-renderer/types';
import { clearSprayWallRegistry, registerSprayWall, setSprayWallLoader } from '../../../lib/spray/spray-wall-registry';
import { _clearRenderBoardTargetCacheForTests } from '../../../lib/playlists/playlist-climb-render-board';
import { useClimbWallGlow } from '../use-climb-wall-glow';

type RenderData = { boardWidth: number; boardHeight: number; holdsData: HoldPlacement[] };
const controls = vi.hoisted(() => ({
  renderData: null as RenderData | null,
  roleColors: new Map<string, string>(),
  getBoardRenderData: vi.fn(),
  useHoldStateColors: vi.fn(),
}));

vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: controls.getBoardRenderData,
}));
vi.mock('../../play-drawer/use-hold-state-colors', () => ({
  useHoldStateColors: controls.useHoldStateColors,
}));

const placements: HoldPlacement[] = [
  { id: 100, cx: 20, cy: 40, r: 5, mirroredHoldId: 200 },
  { id: 200, cx: 80, cy: 40, r: 5, mirroredHoldId: 100 },
];
const board: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const climb: Climb = {
  uuid: 'wall-climb',
  name: 'Wall climb',
  frames: 'p100r12',
  boardType: 'kilter',
  layoutId: 1,
  angle: 40,
  setter_username: 'setter',
  ascensionist_count: 0,
  difficulty: '6a/V3',
  quality_average: '0',
  stars: 0,
  difficulty_error: '',
  benchmark_difficulty: null,
};

beforeEach(() => {
  clearSprayWallRegistry();
  _clearRenderBoardTargetCacheForTests();
  controls.renderData = { boardWidth: 100, boardHeight: 120, holdsData: placements };
  controls.roleColors = new Map([
    ['STARTING', '#123456'],
    ['HAND', '#ABCDEF'],
  ]);
  controls.getBoardRenderData.mockReset().mockImplementation(() => controls.renderData);
  controls.useHoldStateColors.mockReset().mockImplementation(() => controls.roleColors);
});

afterEach(() => {
  cleanup();
  clearSprayWallRegistry();
  setSprayWallLoader(null);
});

describe('useClimbWallGlow', () => {
  it('matches the current palette and committed mirror without rendering board images', () => {
    const { result } = renderHook(() => useClimbWallGlow({ ...climb, mirrored: true }, board, true));
    expect(result.current?.holds).toEqual([{ x: 80, y: 40, color: '#123456' }]);
    expect(controls.useHoldStateColors).toHaveBeenCalledWith('kilter', 1);
  });

  it('updates the pattern and identity when the climb or role palette changes', () => {
    const { result, rerender } = renderHook(({ currentClimb }) => useClimbWallGlow(currentClimb, board, true), {
      initialProps: { currentClimb: climb },
    });
    const firstKey = result.current?.key;
    rerender({ currentClimb: { ...climb, uuid: 'next-climb', frames: 'p200r13' } });
    expect(result.current?.holds).toEqual([{ x: 80, y: 40, color: '#ABCDEF' }]);
    expect(result.current?.key).not.toBe(firstKey);
    const secondKey = result.current?.key;
    controls.roleColors = new Map([['HAND', '#FEDCBA']]);
    rerender({ currentClimb: { ...climb, uuid: 'next-climb', frames: 'p200r13' } });
    expect(result.current?.holds[0]?.color).toBe('#FEDCBA');
    expect(result.current?.key).not.toBe(secondKey);
  });

  it('uses the climb’s own layout when the selected board differs or is absent', () => {
    const homewallClimb = { ...climb, layoutId: 8, angle: 35 };
    const selected = renderHook(() => useClimbWallGlow(homewallClimb, board, true));
    expect(selected.result.current).not.toBeNull();
    expect(controls.getBoardRenderData.mock.calls.at(-1)?.[0]).toMatchObject({ boardName: 'kilter', layoutId: 8 });
    expect(controls.useHoldStateColors).toHaveBeenLastCalledWith('kilter', 8);
    selected.unmount();
    const absent = renderHook(() => useClimbWallGlow(homewallClimb, null, true));
    expect(absent.result.current).not.toBeNull();
    expect(controls.getBoardRenderData.mock.calls.at(-1)?.[0]).toMatchObject({ boardName: 'kilter', layoutId: 8 });
  });

  it.each([false, true])('does not resolve geometry for disabled or empty frames (enabled: %s)', (enabled) => {
    const { result } = renderHook(() => useClimbWallGlow(enabled ? { ...climb, frames: '' } : climb, board, enabled));
    expect(result.current).toBeNull();
    expect(controls.getBoardRenderData).not.toHaveBeenCalled();
  });

  it('returns the flat fallback without a resolvable board or known geometry', () => {
    const unknown = renderHook(() =>
      useClimbWallGlow({ ...climb, boardType: undefined, layoutId: undefined }, null, true),
    );
    expect(unknown.result.current).toBeNull();
    controls.renderData = null;
    const noGeometry = renderHook(() => useClimbWallGlow(climb, board, true));
    expect(noGeometry.result.current).toBeNull();
  });

  it('retains the same geometry and glow input for an unrelated rerender', () => {
    const { result, rerender } = renderHook(() => useClimbWallGlow(climb, board, true));
    const firstInput = result.current;
    const renderCalls = controls.getBoardRenderData.mock.calls.length;
    rerender();
    expect(result.current).toBe(firstInput);
    expect(controls.getBoardRenderData).toHaveBeenCalledTimes(renderCalls);
  });

  it('waits for spray registry geometry without requesting a network load', () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    controls.renderData = null;
    const sprayBoard: BoardConfig = { boardName: 'spray', layoutId: 4200, sizeId: 4200, setIds: '1', angle: 40 };
    const sprayClimb = { ...climb, boardType: 'spray', layoutId: 4200, frames: 'p100r1' };
    const { result } = renderHook(() => useClimbWallGlow(sprayClimb, sprayBoard, true));
    expect(result.current).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    controls.renderData = { boardWidth: 100, boardHeight: 120, holdsData: placements };
    act(() =>
      registerSprayWall(4200, {
        wallUuid: 'story-wall',
        angle: 40,
        version: 1,
        versionId: 1,
        photoWidth: 100,
        photoHeight: 120,
        photoUrl: 'file:///recorded-wall.jpg',
        photoThumbUrl: null,
        photoExpiresAt: '2099-01-01T00:00:00.000Z',
        holds: placements.map(({ id, cx, cy, r }) => ({ id, cx, cy, r })),
      }),
    );
    expect(result.current?.holds).toEqual([{ x: 20, y: 40, color: '#123456' }]);
    expect(loader).not.toHaveBeenCalled();
  });
});
