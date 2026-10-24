// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TickLike } from '../../tick-to-climb';
import type { UseBoardListActivationOptions } from '../use-board-list-activation';
import { describeTickRow, useTickListActivation } from '../use-tick-list-activation';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  options: undefined as UseBoardListActivationOptions<unknown> | undefined,
  openClimbInPlayDrawer: vi.fn(),
  openPlayDrawer: vi.fn(),
  router: { push: vi.fn() },
}));

vi.mock('../use-board-list-activation', () => ({
  useBoardListActivation: (options: UseBoardListActivationOptions<unknown>) => {
    mocks.options = options;
    return mocks.open;
  },
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: mocks.openPlayDrawer }),
}));
vi.mock('expo-router', () => ({ useRouter: () => mocks.router }));
vi.mock('../../open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: mocks.openClimbInPlayDrawer }));

function makeTick(overrides: Partial<TickLike> = {}): TickLike {
  return {
    climbUuid: 'climb-1',
    climbName: 'Moonage',
    frames: 'p1r12',
    angle: 25,
    isBenchmark: false,
    isMirror: false,
    isNoMatch: false,
    boardType: 'kilter',
    layoutId: 1,
    renderBoard: { layoutId: 1, sizeId: 10, setIds: [1, 20] },
    ...overrides,
  } as TickLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options = undefined;
});

describe('describeTickRow', () => {
  it('draws a tick on the board it was climbed on, at its angle', () => {
    const row = describeTickRow(makeTick());

    expect(row.climb).toMatchObject({ uuid: 'climb-1', angle: 25 });
    expect(row.board).toEqual({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 25 });
  });

  it('has no climb for a tick without frames', () => {
    expect(describeTickRow(makeTick({ frames: null })).climb).toBeNull();
  });

  it('reads each tick once', () => {
    const tick = makeTick();

    expect(describeTickRow(tick)).toBe(describeTickRow(tick));
  });
});

describe('useTickListActivation', () => {
  it('hands the rows, label and tick reader to the list hook', () => {
    const rows = [makeTick()];
    const { result } = renderHook(() =>
      useTickListActivation({ sourceId: 'session:1', label: 'Session climbs', rows }),
    );

    expect(result.current).toBe(mocks.open);
    expect(mocks.options).toMatchObject({ sourceId: 'session:1', label: 'Session climbs', rows });
    expect(mocks.options?.describeRow).toBe(describeTickRow);
  });

  it('opens a tick it cannot draw through the climb route, keeping the preview choice', () => {
    renderHook(() => useTickListActivation({ sourceId: 's', label: 'l', rows: [] }));
    const tick = makeTick({ frames: null });

    mocks.options?.openFallback?.(tick, { preview: true });

    expect(mocks.openClimbInPlayDrawer).toHaveBeenCalledWith(
      { kind: 'tick', tick },
      { openPlayDrawer: mocks.openPlayDrawer, router: mocks.router },
      { preview: true },
    );
  });
});
