// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const cfg = vi.hoisted(() => ({
  navigation: {
    addListener: vi.fn(),
    getState: vi.fn(),
    dispatch: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => cfg.navigation,
}));

import { usePopToTopOnTabBlur } from '../use-pop-to-top-on-tab-blur';

function triggerBlur() {
  const call = cfg.navigation.addListener.mock.calls.find(([type]) => type === 'blur');
  call?.[1]();
}

describe('usePopToTopOnTabBlur', () => {
  beforeEach(() => {
    cfg.navigation.addListener.mockReset().mockReturnValue(vi.fn());
    cfg.navigation.getState.mockReset();
    cfg.navigation.dispatch.mockReset();
  });

  it('pops the nested stack to top when the tab loses focus mid-stack', () => {
    // Models Settings pushed into the Profile tab from another tab: the
    // nested stack sits two deep (index/more) when the tab blurs.
    cfg.navigation.getState.mockReturnValue({
      routes: [
        { name: 'home', key: 'home-1' },
        {
          name: 'profile',
          key: 'profile-1',
          state: { type: 'stack', key: 'stack-1', index: 1, routes: [{}, {}] },
        },
      ],
    });

    renderHook(() => usePopToTopOnTabBlur('profile'));
    triggerBlur();

    expect(cfg.navigation.dispatch).toHaveBeenCalledWith({ type: 'POP_TO_TOP', target: 'stack-1' });
  });

  it('does nothing when the nested stack is already at its root', () => {
    cfg.navigation.getState.mockReturnValue({
      routes: [{ name: 'profile', key: 'profile-1', state: { type: 'stack', key: 'stack-1', index: 0, routes: [{}] } }],
    });

    renderHook(() => usePopToTopOnTabBlur('profile'));
    triggerBlur();

    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the tab has no nested stack state yet', () => {
    cfg.navigation.getState.mockReturnValue({ routes: [{ name: 'profile', key: 'profile-1' }] });

    renderHook(() => usePopToTopOnTabBlur('profile'));
    triggerBlur();

    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing for a different tab blurring', () => {
    cfg.navigation.getState.mockReturnValue({
      routes: [
        {
          name: 'discover',
          key: 'discover-1',
          state: { type: 'stack', key: 'discover-stack', index: 1, routes: [{}, {}] },
        },
      ],
    });

    renderHook(() => usePopToTopOnTabBlur('profile'));
    triggerBlur();

    expect(cfg.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('unsubscribes the blur listener on unmount', () => {
    const unsubscribe = vi.fn();
    cfg.navigation.addListener.mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => usePopToTopOnTabBlur('profile'));
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
