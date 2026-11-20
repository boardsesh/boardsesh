// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  openExternalUrl: vi.fn(),
  trackBluetoothUnavailable: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useChoose: () => mocks.choose }));
vi.mock('../../open-url', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../bluetooth-unavailable', () => ({ trackBluetoothUnavailable: mocks.trackBluetoothUnavailable }));

import { useBrowserBluetoothGuidance } from '../use-browser-bluetooth-guidance.web';

describe('browser Bluetooth guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.choose.mockResolvedValue('close');
    mocks.openExternalUrl.mockResolvedValue(undefined);
  });

  it('uses the rendered dialog and records unsupported Bluetooth instead of permission denial', async () => {
    const { result } = renderHook(() => useBrowserBluetoothGuidance());

    await act(async () => result.current('kilter'));

    expect(mocks.choose).toHaveBeenCalledWith({
      title: 'ble.browserUnsupported.title',
      message: 'ble.browserUnsupported.message',
      options: [
        { value: 'close', label: 'common:actions.close', cancel: true },
        { value: 'setup', label: 'ble.browserUnsupported.setup' },
      ],
      cancelValue: 'close',
    });
    expect(mocks.trackBluetoothUnavailable).toHaveBeenCalledWith('unsupported', 'connect', 'kilter');
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens the official setup instructions only when the climber chooses setup', async () => {
    mocks.choose.mockResolvedValue('setup');
    const { result } = renderHook(() => useBrowserBluetoothGuidance());

    await act(async () => result.current('kilter'));

    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      'https://github.com/stevennyman/webbt#installation',
      'browser-bluetooth-guidance',
    );
  });
});
