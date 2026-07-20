// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// Mock the real provider so the test stays a jsdom unit test: BluetoothProvider
// transitively imports react-native, and the web wrapper's only job is to feed it
// the active board and pass children through. Capture the props it was mounted with.
const providerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../bluetooth-provider', () => ({
  BluetoothProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    const { children, ...rest } = props;
    providerProps.current = rest;
    return createElement('div', { 'data-testid': 'bluetooth-provider' }, children);
  },
}));

const activeBoard = vi.hoisted(() => ({ current: undefined as UserBoard | undefined }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current }),
}));

import { BluetoothProviderWrapper } from '../bluetooth-provider-wrapper.web';

describe('BluetoothProviderWrapper on web', () => {
  afterEach(() => {
    cleanup();
    activeBoard.current = undefined;
    providerProps.current = null;
  });

  it('mounts the real Bluetooth provider so Web Bluetooth controls render, passing children through', () => {
    const { getByTestId } = render(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
      </BluetoothProviderWrapper>,
    );

    expect(getByTestId('bluetooth-provider')).toBeTruthy();
    expect(getByTestId('child')).toBeTruthy();
  });

  it('is mounted unconditionally before a board resolves, with undefined board props', () => {
    render(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
      </BluetoothProviderWrapper>,
    );

    expect(providerProps.current).toEqual({
      boardName: undefined,
      layoutId: undefined,
      sizeId: undefined,
      setIds: undefined,
      boardUuid: undefined,
    });
  });

  it('feeds the resolved active board to the provider', () => {
    activeBoard.current = {
      uuid: 'board-uuid',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: [3, 4],
    } as unknown as UserBoard;

    render(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
      </BluetoothProviderWrapper>,
    );

    expect(providerProps.current).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: [3, 4],
      boardUuid: 'board-uuid',
    });
  });
});
