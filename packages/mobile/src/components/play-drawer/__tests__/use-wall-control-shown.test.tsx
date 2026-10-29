// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics-wall-control', () => ({ trackWallControlShown: trackMock }));

import { useWallControlShown } from '../use-wall-control-shown';
import type { WallControlState } from '../wall-control';

type Props = { state: WallControlState; climbUuid: string | null; playerOpen: boolean; visible: boolean };

function setup(initial: Props) {
  return renderHook((props: Props) => useWallControlShown(props), { initialProps: initial });
}

describe('useWallControlShown', () => {
  beforeEach(() => trackMock.mockClear());

  // The connect offer is the same on every climb, so it counts once per open;
  // Put on the wall is an offer about one climb, so it counts per climb.
  it('sends connect once per open and Put on the wall once per climb, however often it renders or comes back', () => {
    const hook = setup({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'b', playerOpen: true, visible: true });
    hook.rerender({ state: 'put_on_wall', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'put_on_wall', climbUuid: 'b', playerOpen: true, visible: true });
    hook.rerender({ state: 'put_on_wall', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'c', playerOpen: true, visible: true });

    expect(trackMock.mock.calls.map(([props]) => props)).toEqual([
      { state: 'connect', climbUuid: 'a' },
      { state: 'put_on_wall', climbUuid: 'a' },
      { state: 'put_on_wall', climbUuid: 'b' },
    ]);
  });

  it('sends nothing for the states that ask nothing, or while the control is covered', () => {
    const hook = setup({ state: 'lit', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'dark', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'crew', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: false });
    expect(trackMock).not.toHaveBeenCalled();
    hook.rerender({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: true });
    expect(trackMock).toHaveBeenCalledOnce();
  });

  it('counts afresh once the player is closed and opened again', () => {
    const hook = setup({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'a', playerOpen: false, visible: true });
    hook.rerender({ state: 'connect', climbUuid: 'a', playerOpen: true, visible: true });
    expect(trackMock).toHaveBeenCalledTimes(2);
  });
});
