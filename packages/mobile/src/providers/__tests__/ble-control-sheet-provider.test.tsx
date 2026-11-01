// @vitest-environment jsdom
import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctrl = vi.hoisted(() => ({
  bluetooth: null as { isConnected: boolean } | null,
  track: vi.fn(),
}));

vi.mock('../bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ctrl.bluetooth }));
vi.mock('../../lib/analytics', () => ({ track: ctrl.track }));
vi.mock('../../components/ble/BleControlSheetHost', () => ({
  BleControlSheetHost: ({ visible }: { visible: boolean }) => createElement('div', { 'data-sheet-visible': visible }),
}));

import { BleControlSheetProvider, useBleControlSheet } from '../ble-control-sheet-provider';

function renderProvider() {
  let api: ReturnType<typeof useBleControlSheet> | null = null;
  function Capture() {
    api = useBleControlSheet();
    return null;
  }
  const utils = render(createElement(BleControlSheetProvider, null, createElement(Capture)));
  return { ...utils, open: (...args: Parameters<ReturnType<typeof useBleControlSheet>['open']>) => api!.open(...args) };
}

const sheetVisible = (container: HTMLElement) =>
  container.querySelector('[data-sheet-visible]')?.getAttribute('data-sheet-visible');

describe('BleControlSheetProvider', () => {
  beforeEach(() => {
    ctrl.bluetooth = null;
    ctrl.track.mockClear();
  });

  it('opens and logs Board Controls Opened with the control that asked', () => {
    ctrl.bluetooth = { isConnected: true };
    const { container, open } = renderProvider();
    act(() => open({ surface: 'header_pill' }));
    expect(sheetVisible(container)).toBe('true');
    expect(ctrl.track).toHaveBeenCalledWith('Board Controls Opened', { surface: 'header_pill' });
  });

  it('carries the platter placement when there is one', () => {
    ctrl.bluetooth = { isConnected: true };
    const { open } = renderProvider();
    act(() => open({ surface: 'board_control_indicator', placement: 'inline' }));
    expect(ctrl.track).toHaveBeenCalledWith('Board Controls Opened', {
      surface: 'board_control_indicator',
      placement: 'inline',
    });
  });

  it('neither opens nor logs without a radio link to control', () => {
    ctrl.bluetooth = { isConnected: false };
    const { container, open } = renderProvider();
    act(() => open({ surface: 'toolbar' }));
    expect(sheetVisible(container)).toBe('false');
    expect(ctrl.track).not.toHaveBeenCalled();
  });
});
