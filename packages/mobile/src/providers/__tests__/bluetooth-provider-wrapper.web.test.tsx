// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// Mock the real provider so the test stays a jsdom unit test: BluetoothProvider
// transitively imports react-native, and the web wrapper's only job is to feed it
// the active board and pass children through. Capture the props it was mounted with.
const providerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const quantumProviderProps = vi.hoisted(() => ({
  selectedModelId: null as string | null,
  selectedBoardUuid: null as string | null | undefined,
  preferredSerial: undefined as string | null | undefined,
}));
vi.mock('../bluetooth-provider', () => ({
  BluetoothProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    const { children, ...rest } = props;
    providerProps.current = rest;
    return createElement('div', { 'data-testid': 'bluetooth-provider' }, children);
  },
}));

vi.mock('../quantum-bluetooth-provider', () => ({
  QuantumBluetoothProvider: ({
    children,
    selectedModelId,
    selectedBoardUuid,
    preferredSerial,
  }: {
    children: ReactNode;
    selectedModelId: string | null;
    selectedBoardUuid?: string | null;
    preferredSerial?: string | null;
  }) => {
    quantumProviderProps.selectedModelId = selectedModelId;
    quantumProviderProps.selectedBoardUuid = selectedBoardUuid;
    quantumProviderProps.preferredSerial = preferredSerial;
    return createElement('div', { 'data-testid': 'quantum-bluetooth-provider' }, children);
  },
}));

const activeBoard = vi.hoisted(() => ({ current: undefined as UserBoard | undefined }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: activeBoard.current }),
}));

const flags = vi.hoisted(() => ({ enabled: true, resolved: true }));
vi.mock('../feature-flags-provider', () => ({
  useFeatureFlag: () => flags.enabled,
  useFeatureFlagsResolved: () => flags.resolved,
}));

import { BluetoothProviderWrapper } from '../bluetooth-provider-wrapper.web';

describe('BluetoothProviderWrapper on web', () => {
  afterEach(() => {
    cleanup();
    flags.enabled = true;
    flags.resolved = true;
    activeBoard.current = undefined;
    providerProps.current = null;
    quantumProviderProps.selectedModelId = null;
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

  it('keeps Quantum inactive across ordinary saved-board serial changes', () => {
    activeBoard.current = {
      uuid: 'board-A',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      serialNumber: 'KILTER-A',
    } as UserBoard;
    const view = render(
      <BluetoothProviderWrapper>
        <div />
      </BluetoothProviderWrapper>,
    );
    expect(quantumProviderProps.selectedModelId).toBeNull();
    expect(quantumProviderProps.selectedBoardUuid).toBeNull();
    expect(quantumProviderProps.preferredSerial).toBeUndefined();
    activeBoard.current = { ...activeBoard.current, uuid: 'board-B', serialNumber: 'KILTER-B' };
    view.rerender(
      <BluetoothProviderWrapper>
        <div />
      </BluetoothProviderWrapper>,
    );
    expect(quantumProviderProps.selectedModelId).toBeNull();
    expect(quantumProviderProps.selectedBoardUuid).toBeNull();
    expect(quantumProviderProps.preferredSerial).toBeUndefined();
  });

  it('routes Quantum to its explicit-layer provider and disables the legacy auto-sender', () => {
    activeBoard.current = {
      uuid: 'quantum-board-uuid',
      boardType: 'quantum',
      layoutId: 9101,
      sizeId: 9203,
      setIds: [1],
    } as unknown as UserBoard;

    const view = render(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
      </BluetoothProviderWrapper>,
    );

    expect(quantumProviderProps.selectedModelId).toBe('m');
    expect(quantumProviderProps.selectedBoardUuid).toBe('quantum-board-uuid');
    activeBoard.current = { ...activeBoard.current!, sizeId: 9202 };
    view.rerender(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
      </BluetoothProviderWrapper>,
    );
    expect(quantumProviderProps.selectedModelId).toBe('l');
    expect(providerProps.current).toEqual({
      boardName: undefined,
      layoutId: undefined,
      sizeId: undefined,
      setIds: undefined,
      boardUuid: undefined,
    });
  });
  it('keeps the controller inactive while the flag is unresolved or off, or the model is unreleased', () => {
    activeBoard.current = {
      uuid: 'quantum-board-uuid',
      boardType: 'quantum',
      layoutId: 9101,
      sizeId: 9201,
    } as UserBoard;
    const child = (
      <BluetoothProviderWrapper>
        <div />
      </BluetoothProviderWrapper>
    );
    flags.resolved = false;
    const view = render(child);
    expect(quantumProviderProps.selectedModelId).toBeNull();
    flags.resolved = true;
    flags.enabled = false;
    view.rerender(
      <BluetoothProviderWrapper>
        <div />
      </BluetoothProviderWrapper>,
    );
    expect(quantumProviderProps.selectedModelId).toBeNull();
    flags.enabled = true;
    activeBoard.current = { ...activeBoard.current, layoutId: 9105, sizeId: 9205 };
    view.rerender(
      <BluetoothProviderWrapper>
        <div />
      </BluetoothProviderWrapper>,
    );
    expect(quantumProviderProps.selectedModelId).toBeNull();
  });
});
