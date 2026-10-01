// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const cfg = vi.hoisted(() => ({
  navigation: { addListener: vi.fn(), getState: vi.fn(), dispatch: vi.fn() },
}));
vi.mock('expo-router', () => ({ useNavigation: () => cfg.navigation }));

import { usePopToTopOnTabBlur } from '../use-pop-to-top-on-tab-blur';

function tabState(index = 0, nestedIndex = 1) {
  return {
    type: 'tab',
    key: 'tabs-1',
    index,
    routes: [
      {
        name: 'discover',
        key: 'discover-1',
        state: {
          type: 'stack',
          key: 'discover-stack',
          index: nestedIndex,
          routes: [{ name: 'index' }, { name: 'playlist' }],
        },
      },
      { name: 'climbs', key: 'climbs-1' },
    ],
  };
}

function emitState(state: unknown) {
  cfg.navigation.getState.mockReturnValue(state);
  cfg.navigation.addListener.mock.calls.find(([type]) => type === 'state')?.[1]({ data: { state } });
}
function emitBlur() {
  cfg.navigation.addListener.mock.calls.find(([type]) => type === 'blur')?.[1]();
}

const expectedPop = { type: 'POP_TO_TOP', target: 'discover-stack' };

describe('usePopToTopOnTabBlur', () => {
  beforeEach(() => {
    cfg.navigation.addListener.mockReset().mockReturnValue(vi.fn());
    cfg.navigation.getState.mockReset().mockReturnValue(tabState());
    cfg.navigation.dispatch.mockReset();
  });

  it.each(['blur-first', 'state-first'])('resets once on a real tab departure (%s)', (ordering) => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    if (ordering === 'blur-first') emitBlur();
    emitState(tabState(1));
    if (ordering === 'state-first') emitBlur();
    emitState(tabState(1, 0));
    expect(cfg.navigation.dispatch).toHaveBeenCalledExactlyOnceWith(expectedPop);
  });

  it('preserves a playlist while a player covers, blurs, and uncovers its tab', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitBlur();
    emitState(tabState());
    emitState(tabState());
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('preserves history on nested navigation and a cancelled tab gesture', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(0, 0));
    emitState(tabState());
    emitBlur();
    emitState(tabState());
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('resets on a programmatic tab departure while the player remains open', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitBlur();
    emitState(tabState());
    emitState(tabState(1));
    expect(cfg.navigation.dispatch).toHaveBeenCalledExactlyOnceWith(expectedPop);
  });

  it('updates selection before dispatch to prevent reentrant duplicate pops', () => {
    cfg.navigation.dispatch.mockImplementation(() => emitState(tabState(1, 0)));
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(1));
    expect(cfg.navigation.dispatch).toHaveBeenCalledExactlyOnceWith(expectedPop);
  });

  it('can reset again after returning to the tab and opening another playlist', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(1));
    emitState(tabState(0, 0));
    emitState(tabState());
    emitState(tabState(1));
    expect(cfg.navigation.dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not reset a stack already at its root', () => {
    cfg.navigation.getState.mockReturnValue(tabState(0, 0));
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(1, 0));
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('does not reset on initial mount or when a different tab changes', () => {
    cfg.navigation.getState.mockReturnValue(tabState(1));
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(1));
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { type: 'tab', routes: tabState().routes },
    { type: 'tab', index: 3, routes: tabState().routes },
    { type: 'tab', index: 0, routes: undefined },
    { type: 'stack', index: 0, routes: tabState().routes },
    { type: 'tab', index: 0, routes: [{ name: 'climbs', key: 'climbs-1' }] },
  ])('fails closed for an unknown parent selection: %j', (partialState) => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(partialState);
    emitState(tabState(1));
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { type: 'stack', key: 'discover-stack', routes: [{}, {}] },
    { type: 'stack', key: 'discover-stack', index: 1 },
    { type: 'stack', index: 1, routes: [{}, {}] },
    { type: 'tab', key: 'discover-stack', index: 1, routes: [{}, {}] },
    { type: 'stack', key: 'discover-stack', index: 5, routes: [{}, {}] },
  ])('does not dispatch against an unknown nested stack: %j', (nestedState) => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    const departingState = tabState(1);
    emitState({
      ...departingState,
      routes: [{ ...departingState.routes[0], state: nestedState }, departingState.routes[1]],
    });
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('unsubscribes the state listener on unmount', () => {
    const unsubscribe = vi.fn();
    cfg.navigation.addListener.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => usePopToTopOnTabBlur('discover'));
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
