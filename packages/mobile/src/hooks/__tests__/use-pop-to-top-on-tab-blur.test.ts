// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const cfg = vi.hoisted(() => ({
  navigation: { addListener: vi.fn(), getState: vi.fn(), dispatch: vi.fn() },
}));
vi.mock('expo-router', () => ({ useNavigation: () => cfg.navigation }));

import { usePopToTopOnTabBlur } from '../use-pop-to-top-on-tab-blur';

function tabState(index = 0, nestedIndex = 1, firstTabName = 'discover', secondTabName = 'climbs') {
  return {
    stale: false,
    type: 'tab',
    key: 'tabs-1',
    index,
    routes: [
      {
        name: firstTabName,
        key: `${firstTabName}-1`,
        state: {
          type: 'stack',
          key: `${firstTabName}-stack`,
          index: nestedIndex,
          routes: [{ name: 'index' }, { name: 'playlist' }],
        },
      },
      { name: secondTabName, key: `${secondTabName}-1` },
    ],
  };
}

function emitState(state: unknown) {
  cfg.navigation.getState.mockReturnValue(state);
  cfg.navigation.addListener.mock.calls.find(([type]) => type === 'state')?.[1]({ data: { state } });
}
function expectNoBlurListener() {
  expect(cfg.navigation.addListener.mock.calls.filter(([type]) => type === 'blur')).toHaveLength(0);
}

const expectedPop = { type: 'POP_TO_TOP', target: 'discover-stack' };

describe('usePopToTopOnTabBlur', () => {
  beforeEach(() => {
    cfg.navigation.addListener.mockReset().mockReturnValue(vi.fn());
    cfg.navigation.getState.mockReset().mockReturnValue(tabState());
    cfg.navigation.dispatch.mockReset();
  });

  it('resets once on a real tab departure and ignores repeated state events', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(1));
    emitState(tabState(1, 0));
    emitState(tabState(1, 0));
    expect(cfg.navigation.dispatch).toHaveBeenCalledExactlyOnceWith(expectedPop);
  });

  it('preserves a playlist when the parent tab selection is unchanged', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    expectNoBlurListener();
    emitState(tabState());
    emitState(tabState());
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('preserves history on nested navigation without a parent tab departure', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState(tabState(0, 0));
    emitState(tabState());
    emitState(tabState());
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('resets on a programmatic parent tab selection change', () => {
    renderHook(() => usePopToTopOnTabBlur('discover'));
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

  it.each(['discover', 'profile', 'climbs'] as const)('targets the departing %s stack', (tabName) => {
    const selectedTabState = tabState(0, 1, tabName, 'other');
    cfg.navigation.getState.mockReturnValue(selectedTabState);
    renderHook(() => usePopToTopOnTabBlur(tabName));
    emitState({ ...selectedTabState, index: 1 });
    expect(cfg.navigation.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: 'POP_TO_TOP',
      target: `${tabName}-stack`,
    });
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

  it('warns once when a complete tab state omits this tab route', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => usePopToTopOnTabBlur('discover'));
    const missingRouteState = tabState(0, 1, 'profile', 'climbs');
    emitState(missingRouteState);
    emitState(missingRouteState);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[usePopToTopOnTabBlur] Tab route "discover" was not found in the parent tab navigator.',
    );
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn when a partial tab state omits this tab route', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => usePopToTopOnTabBlur('discover'));
    emitState({ type: 'tab', index: 0, routes: [{ name: 'climbs', key: 'climbs-1' }] });
    expect(warn).not.toHaveBeenCalled();
    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
    warn.mockRestore();
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
    const listenerUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    cfg.navigation.addListener.mockImplementation(() => {
      const unsubscribe = vi.fn();
      listenerUnsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    const { unmount } = renderHook(() => usePopToTopOnTabBlur('discover'));
    expect(cfg.navigation.addListener).toHaveBeenCalledExactlyOnceWith('state', expect.any(Function));
    unmount();
    expect(listenerUnsubscribes).toHaveLength(1);
    for (const unsubscribe of listenerUnsubscribes) expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
