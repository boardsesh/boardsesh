// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionRunRequest } from '../ClimbActionRunner';

// A pick in the iOS native context menu runs through the same useClimbActions
// list the overlay renders, with the options the surface passed. These pin that
// it runs the picked action exactly once, waits for the favourite state before
// toggling it, and falls back to the overlay rather than doing nothing.

const ctrl = vi.hoisted(() => ({
  favoriteLoading: false,
  offered: ['tick', 'favorite', 'playlist'] as string[],
  hookArgs: null as Record<string, unknown> | null,
  runs: [] as string[],
}));

vi.mock('../use-climb-actions', () => ({
  useClimbActions: (args: Record<string, unknown>) => {
    ctrl.hookArgs = args;
    return ctrl.offered.map((id) => ({
      id,
      title: id,
      icon: 'add',
      color: '#000',
      run: () => {
        ctrl.runs.push(id);
        if (id === 'playlist') (args.onSelectPlaylist as () => void)();
        else (args.onAfterAction as () => void)();
      },
    }));
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useFavoriteStatus: () => ({ isLoading: ctrl.favoriteLoading }),
}));

import { ClimbActionRunner } from '../ClimbActionRunner';

const climb = { uuid: 'climb-1', name: 'Big Move' } as unknown as Climb;
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function renderRunner(request: Partial<ClimbActionRunRequest> = {}) {
  const onDone = vi.fn();
  const onShowOverlay = vi.fn();
  const fullRequest: ClimbActionRunRequest = { nonce: 7, actionId: 'tick', climb, boardConfig, ...request };
  const element = () => (
    <ClimbActionRunner
      request={fullRequest}
      currentUserId="user-1"
      isAuthenticated
      onDone={onDone}
      onShowOverlay={onShowOverlay}
    />
  );
  const result = render(element());
  return { ...result, onDone, onShowOverlay, request: fullRequest, rerenderSame: () => result.rerender(element()) };
}

beforeEach(() => {
  ctrl.favoriteLoading = false;
  ctrl.offered = ['tick', 'favorite', 'playlist'];
  ctrl.hookArgs = null;
  ctrl.runs = [];
});

describe('ClimbActionRunner', () => {
  it('runs the picked action once, then reports its own run done', () => {
    const { onDone, rerenderSame } = renderRunner();
    rerenderSame();
    expect(ctrl.runs).toEqual(['tick']);
    expect(onDone).toHaveBeenCalledWith(7);
  });

  it('builds the list with the options the surface gave openClimbActions', () => {
    const onTick = vi.fn();
    const onEditEntry = vi.fn();
    renderRunner({ options: { onTick, onEditEntry, queueItemUuid: 'slot-2' } });
    expect(ctrl.hookArgs).toMatchObject({
      climb,
      boardConfig,
      currentUserId: 'user-1',
      isAuthenticated: true,
      onTick,
      onEditEntry,
      queueItemUuid: 'slot-2',
    });
  });

  it('waits for the favourite state before toggling it', () => {
    ctrl.favoriteLoading = true;
    const { rerenderSame } = renderRunner({ actionId: 'favorite' });
    expect(ctrl.runs).toEqual([]);

    ctrl.favoriteLoading = false;
    rerenderSame();
    expect(ctrl.runs).toEqual(['favorite']);
  });

  it('opens the overlay on its picker when the action needs one', () => {
    const { onShowOverlay, request } = renderRunner({ actionId: 'playlist' });
    expect(onShowOverlay).toHaveBeenCalledWith(request, 'playlist');
  });

  it('opens the full overlay when the picked action is no longer offered', () => {
    ctrl.offered = ['tick'];
    const { onShowOverlay, onDone, request } = renderRunner({ actionId: 'playNext' });
    expect(ctrl.runs).toEqual([]);
    expect(onShowOverlay).toHaveBeenCalledWith(request, 'menu');
    expect(onDone).not.toHaveBeenCalled();
  });
});
