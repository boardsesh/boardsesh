// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const focusCtrl = vi.hoisted(() => ({ isFocused: true }));
const backCtrl = vi.hoisted(() => ({
  handlers: [] as (() => boolean)[],
  removals: 0,
}));

vi.mock('expo-router', () => ({ useIsFocused: () => focusCtrl.isFocused }));
vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backCtrl.handlers.push(handler);
      return {
        remove: () => {
          backCtrl.removals += 1;
          backCtrl.handlers = backCtrl.handlers.filter((entry) => entry !== handler);
        },
      };
    },
  },
}));

import { useBlockBack } from '../use-block-back';

describe('useBlockBack', () => {
  beforeEach(() => {
    focusCtrl.isFocused = true;
    backCtrl.handlers = [];
    backCtrl.removals = 0;
  });

  it('swallows the press while the step is in front', () => {
    renderHook(() => useBlockBack());

    expect(backCtrl.handlers).toHaveLength(1);
    expect(backCtrl.handlers[0]?.()).toBe(true);
  });

  it('releases the handler on unmount', () => {
    const { unmount } = renderHook(() => useBlockBack());
    unmount();

    expect(backCtrl.removals).toBe(1);
    expect(backCtrl.handlers).toHaveLength(0);
  });

  // BackHandler dispatches newest-first and stops at the first `true`, and React
  // Navigation registers its handler once at container mount — so a blocker added
  // later always runs ahead of it, including while its screen sits mounted
  // UNDERNEATH a pushed one. Unregistering on blur is what keeps back working
  // inside /boards, /boards/create and /gyms after "Find another board".
  it('registers nothing while the step is behind a pushed screen', () => {
    focusCtrl.isFocused = false;
    renderHook(() => useBlockBack());

    expect(backCtrl.handlers).toHaveLength(0);
  });

  it('re-registers when the step comes back to the front', () => {
    focusCtrl.isFocused = true;
    const { rerender } = renderHook(() => useBlockBack());
    expect(backCtrl.handlers).toHaveLength(1);

    focusCtrl.isFocused = false;
    rerender();
    expect(backCtrl.handlers).toHaveLength(0);

    focusCtrl.isFocused = true;
    rerender();
    expect(backCtrl.handlers).toHaveLength(1);
  });
});
