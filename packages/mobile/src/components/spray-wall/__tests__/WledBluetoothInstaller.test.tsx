// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallerSnapshot } from '../../../lib/wled-installer/engine';

const runtime = vi.hoisted(() => ({ snapshot: null as InstallerSnapshot | null, install: vi.fn() }));
vi.mock('../../../lib/wled-installer/native', () => ({ nativeInstallerIO: {} }));
vi.mock('../../../lib/wled-installer/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/wled-installer/engine')>()),
  createWledInstaller: (_url: string, _io: unknown, publish: (snapshot: InstallerSnapshot) => void) => ({
    inspect: async () => publish(runtime.snapshot!),
    install: runtime.install,
    cancel: vi.fn(),
    exportBackup: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ subscribeToCredentialChanges: () => () => undefined }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666' },
    brandColors: { error: '#900' },
    spacing: [0, 4, 8],
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (checked: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
import { WledBluetoothInstaller } from '../WledBluetoothInstaller';

function readySnapshot(): InstallerSnapshot {
  return {
    stage: 'ready',
    release: {
      id: 'beta-audio',
      channel: 'beta',
      qualified: false,
      hardwareModel: 'GL-C-015WL-D',
      architecture: 'esp32',
      flashBytes: 4_194_304,
      sourceProfiles: [{ version: '16.0.1', brand: 'WLED', product: 'FOSS', appSlotBytes: 1_572_864 }],
      wledVersion: '16.0.1',
      usermodVersion: '0.1.0',
      protocolVersion: 1,
      buildId: 'test-audio',
      audio: true,
      imageBytes: 1_000_000,
      appSlotBytes: 1_572_864,
      url: 'https://example.com/firmware.bin',
      sha256: 'a'.repeat(64),
    },
    backup: { uri: 'file:///backup.json', config: {}, presets: {} },
  };
}
function checkbox(key: 'confirmModel' | 'confirmBeta' | 'confirmNoAudio') {
  return screen.getByRole('switch', { name: `sprayLed.installer.${key}` }) as HTMLInputElement;
}
async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'sprayLed.installer.inspect' }));
  await screen.findByRole('switch', { name: 'sprayLed.installer.confirmModel' });
}
beforeEach(() => {
  vi.clearAllMocks();
  runtime.snapshot = readySnapshot();
});
afterEach(cleanup);

describe('WLED beta installer consent', () => {
  it('discloses beta before checking the controller and requires beta plus model consent', async () => {
    render(<WledBluetoothInstaller url="192.168.1.5" disabled={false} />);
    expect(screen.getByText('sprayLed.installer.title')).toBeTruthy();
    expect(screen.getByText('sprayLed.installer.betaWarning')).toBeTruthy();
    expect(runtime.install).not.toHaveBeenCalled();
    await inspect();
    const install = screen.getByRole('button', { name: 'sprayLed.installer.installBeta' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(checkbox('confirmModel'));
    expect(install.disabled).toBe(true);
    fireEvent.click(checkbox('confirmBeta'));
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    expect(runtime.install).toHaveBeenCalledWith(true, false, true);
  });
  it('keeps no-audio approval separate from beta approval', async () => {
    runtime.snapshot!.release!.audio = false;
    render(<WledBluetoothInstaller url="192.168.1.5" disabled={false} />);
    await inspect();
    fireEvent.click(checkbox('confirmModel'));
    fireEvent.click(checkbox('confirmBeta'));
    const install = screen.getByRole('button', { name: 'sprayLed.installer.installBeta' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(checkbox('confirmNoAudio'));
    fireEvent.click(install);
    expect(runtime.install).toHaveBeenCalledWith(true, true, true);
  });
  it('resets confirmations when the owner checks again or changes the controller URL', async () => {
    const view = render(<WledBluetoothInstaller url="192.168.1.5" disabled={false} />);
    await inspect();
    fireEvent.click(checkbox('confirmModel'));
    fireEvent.click(checkbox('confirmBeta'));
    await inspect();
    await waitFor(() => expect(checkbox('confirmBeta').checked).toBe(false));
    expect(checkbox('confirmModel').checked).toBe(false);
    fireEvent.click(checkbox('confirmModel'));
    fireEvent.click(checkbox('confirmBeta'));
    view.rerender(<WledBluetoothInstaller url="192.168.1.6" disabled={false} />);
    await inspect();
    expect(checkbox('confirmBeta').checked).toBe(false);
    expect(checkbox('confirmModel').checked).toBe(false);
  });
  it('requires no beta checkbox for an explicitly stable qualified release', async () => {
    runtime.snapshot!.release!.channel = 'stable';
    runtime.snapshot!.release!.qualified = true;
    render(<WledBluetoothInstaller url="192.168.1.5" disabled={false} />);
    await inspect();
    expect(screen.queryByRole('switch', { name: 'sprayLed.installer.confirmBeta' })).toBeNull();
    fireEvent.click(checkbox('confirmModel'));
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.installer.install' }));
    expect(runtime.install).toHaveBeenCalledWith(true, false, false);
  });
});
