// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// Controllable active-board read. The whole point of the regression is the
// async undefined -> board transition, so the test drives it explicitly.
const activeBoard = vi.hoisted(() => ({ data: undefined as UserBoard | undefined }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.data }),
}));

// BluetoothProvider is stubbed to a passthrough so the test exercises only the
// wrapper's element-stability decision, not the real BLE provider's internals.
vi.mock('../bluetooth-provider', () => ({
  BluetoothProvider: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'bluetooth-provider' }, children),
}));

vi.mock('../../lib/live-activity/live-activity-bridge', () => ({
  LiveActivityBridge: () => createElement('div', { 'data-testid': 'live-activity-bridge' }),
}));

import { BluetoothProviderWrapper } from '../bluetooth-provider-wrapper';

const mountCounter = vi.fn();

// A child that records each mount. If the wrapper swaps the element at its
// position when the board resolves, React unmounts and remounts this subtree,
// so the mount count climbs past 1.
function MountProbe() {
  useEffect(() => {
    mountCounter();
  }, []);
  return createElement('div', { 'data-testid': 'mount-probe' });
}

const board = {
  uuid: 'board-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3,4',
} as unknown as UserBoard;

describe('BluetoothProviderWrapper', () => {
  beforeEach(() => {
    activeBoard.data = undefined;
    mountCounter.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the child subtree mounted across the undefined -> board transition', () => {
    const { rerender } = render(createElement(BluetoothProviderWrapper, null, createElement(MountProbe)));

    // First commit: no stored board yet (async AsyncStorage read pending).
    expect(mountCounter).toHaveBeenCalledTimes(1);

    // The stored board resolves a tick later.
    activeBoard.data = board;
    rerender(createElement(BluetoothProviderWrapper, null, createElement(MountProbe)));

    // The child must NOT remount: BluetoothProvider stays at the same tree
    // position, so the navigation subtree below it is untouched.
    expect(mountCounter).toHaveBeenCalledTimes(1);
  });

  it('only mounts the LiveActivityBridge once a board is present', () => {
    const { queryByTestId, rerender } = render(
      createElement(BluetoothProviderWrapper, null, createElement(MountProbe)),
    );
    expect(queryByTestId('live-activity-bridge')).toBeNull();

    activeBoard.data = board;
    rerender(createElement(BluetoothProviderWrapper, null, createElement(MountProbe)));
    expect(queryByTestId('live-activity-bridge')).not.toBeNull();
  });
});
