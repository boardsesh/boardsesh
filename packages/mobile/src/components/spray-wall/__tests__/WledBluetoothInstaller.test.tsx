// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallerSnapshot } from '../../../lib/wled-installer/engine';

type Publish = (snapshot: InstallerSnapshot) => void;
const runtime = vi.hoisted(() => ({
  snapshot: null as InstallerSnapshot | null,
  install: vi.fn(),
  release: vi.fn(),
  hotspotInspect: vi.fn(),
  hotspotCreated: vi.fn(),
  publish: null as ((snapshot: InstallerSnapshot) => void) | null,
  joining: false,
  appStateListener: null as ((state: string) => void) | null,
}));
vi.mock('../../../lib/wled-installer/native', () => ({ nativeInstallerIO: {} }));
vi.mock('../../../lib/wled-installer/hotspot', () => ({
  createNativeHotspotLink: (credentials: unknown) => {
    runtime.hotspotCreated(credentials);
    return { isJoining: () => runtime.joining, isJoined: () => true };
  },
  hotspotInstallerIO: (io: unknown) => io,
}));
vi.mock('../../../lib/wled-installer/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/wled-installer/engine')>();
  const session = (publish: Publish, inspect: (betaConfirmed?: boolean) => Promise<void>) => ({
    inspect,
    install: runtime.install,
    cancel: vi.fn(),
    release: runtime.release,
    exportBackup: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    getSnapshot: () => runtime.snapshot!,
    publish,
  });
  return {
    ...actual,
    createWledInstaller: (_url: string, _io: unknown, publish: Publish) =>
      session(publish, async () => publish(runtime.snapshot!)),
    createWledHotspotInstaller: (_io: unknown, _link: unknown, publish: Publish) => {
      runtime.publish = publish;
      return session(publish, async (betaConfirmed) => {
        runtime.hotspotInspect(betaConfirmed);
        publish(runtime.snapshot!);
      });
    },
  };
});
vi.mock('../../../lib/privacy/privacy-cache', () => ({ subscribeToCredentialChanges: () => () => undefined }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: vi.fn() },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      runtime.appStateListener = listener;
      return { remove: () => undefined };
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  SectionLabel: ({ children }: { children?: ReactNode }) => createElement('label', null, children),
  BuilderTextInput: ({
    value,
    accessibilityLabel,
    onChangeText,
  }: {
    value: string;
    accessibilityLabel: string;
    onChangeText: (next: string) => void;
  }) =>
    createElement('input', {
      'aria-label': accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
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
  runtime.joining = false;
  runtime.publish = null;
});
afterEach(cleanup);

describe('WLED beta installer consent', () => {
  it('discloses beta before checking the controller and requires beta plus model consent', async () => {
    render(<WledBluetoothInstaller url="192.168.1.5" wallName="Norte izquierda" disabled={false} />);
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
    expect(runtime.install).toHaveBeenCalledWith(true, false, true, 'Norte izquierda', false);
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
    expect(runtime.install).toHaveBeenCalledWith(true, true, true, '', false);
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
    expect(runtime.install).toHaveBeenCalledWith(true, false, false, '', false);
  });
  it("suggests the wall's name for the controller, trimmed as the add-on advertises it", async () => {
    render(<WledBluetoothInstaller url="192.168.1.5" wallName="Wall #2 @ the gym" disabled={false} />);
    await inspect();
    const field = screen.getByLabelText('sprayLed.installer.controllerName') as HTMLInputElement;
    expect(field.value).toBe('Wall 2  the gym');
    fireEvent.change(field, { target: { value: 'Rocódromo Escalada Norte' } });
    fireEvent.click(checkbox('confirmModel'));
    fireEvent.click(checkbox('confirmBeta'));
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.installer.installBeta' }));
    // 22 UTF-8 bytes: "ó" takes two, so the "r" no longer fits.
    expect(runtime.install).toHaveBeenCalledWith(true, false, true, 'Rocódromo Escalada No', false);
  });
});

function switchNamed(name: string) {
  return screen.getByRole('switch', { name }) as HTMLInputElement;
}
async function startHotspot() {
  fireEvent.click(switchNamed('sprayLed.installer.confirmBeta'));
  fireEvent.click(screen.getByRole('button', { name: 'sprayLed.installer.hotspot.start' }));
  await waitFor(() => expect(runtime.hotspotInspect).toHaveBeenCalled());
}

describe('WLED install over the controller hotspot', () => {
  it('offers the hotspot route with WLED-AP defaults when no address is saved', () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    const toggle = switchNamed('sprayLed.installer.hotspot.toggle');
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect((screen.getByLabelText('sprayLed.installer.hotspot.ssid') as HTMLInputElement).value).toBe('WLED-AP');
    expect((screen.getByLabelText('sprayLed.installer.hotspot.passwordLabel') as HTMLInputElement).value).toBe(
      'wled1234',
    );
    expect(screen.getByText('sprayLed.installer.hotspot.hint')).toBeTruthy();
  });

  it('keeps Wi-Fi as the default when an address is saved, with the hotspot one tap away', () => {
    render(<WledBluetoothInstaller url="192.168.1.5" disabled={false} />);
    const toggle = switchNamed('sprayLed.installer.hotspot.toggle');
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'sprayLed.installer.hotspot.start' })).toBeTruthy();
  });

  it('asks for beta consent before downloading, then passes the typed hotspot', async () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    const start = screen.getByRole('button', { name: 'sprayLed.installer.hotspot.start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('sprayLed.installer.hotspot.ssid'), { target: { value: 'WLED-Gym' } });
    await startHotspot();
    expect(runtime.hotspotCreated).toHaveBeenCalledWith({ ssid: 'WLED-Gym', passphrase: 'wled1234' });
    expect(runtime.hotspotInspect).toHaveBeenCalledWith(true);
  });

  it.each([
    ['downloading', 'sprayLed.installer.hotspot.downloading'],
    ['connecting', 'sprayLed.installer.hotspot.connecting'],
    ['uploading', 'sprayLed.installer.uploading'],
    ['rebooting', 'sprayLed.installer.hotspot.rebooting'],
    ['verifying', 'sprayLed.installer.verifying'],
    ['complete', 'sprayLed.installer.hotspot.complete'],
  ] as const)('shows the %s state', async (stage, message) => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    act(() => runtime.publish!({ stage }));
    expect(screen.getByText(message)).toBeTruthy();
  });

  it.each([
    ['hotspotNotFound', 'sprayLed.installer.hotspot.notFound'],
    ['hotspotDenied', 'sprayLed.installer.hotspot.denied'],
    ['hotspotTimeout', 'sprayLed.installer.hotspot.timeout'],
    ['hotspotPassword', 'sprayLed.installer.hotspot.password'],
    ['hotspotUnsupported', 'sprayLed.installer.hotspot.unsupported'],
  ] as const)('explains a %s join failure and offers a retry', async (error, message) => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    act(() => runtime.publish!({ stage: 'failed', error }));
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    const retry = screen.getByRole('button', { name: 'sprayLed.installer.hotspot.start' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  it('explains a lost hotspot after the restart and offers the installation check', async () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    act(() => runtime.publish!({ stage: 'interrupted', error: 'hotspotLost' }));
    expect(screen.getByText('sprayLed.installer.hotspot.lost')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'sprayLed.installer.verify' })).toBeTruthy();
  });

  it('releases the hotspot when the screen unmounts', async () => {
    const view = render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    runtime.release.mockClear();
    view.unmount();
    expect(runtime.release).toHaveBeenCalled();
  });

  it('releases the hotspot when the app goes to the background, but not for the join prompt', async () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    runtime.release.mockClear();
    runtime.joining = true;
    act(() => runtime.appStateListener!('background'));
    expect(runtime.release).not.toHaveBeenCalled();
    runtime.joining = false;
    act(() => runtime.appStateListener!('background'));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('releases the hotspot when the owner disconnects at the ready backup', async () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    runtime.release.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.installer.hotspot.leave' }));
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(screen.getByText('sprayLed.installer.hotspot.hint')).toBeTruthy();
  });

  it('releases the hotspot when the section is disabled', async () => {
    const view = render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    runtime.release.mockClear();
    view.rerender(<WledBluetoothInstaller url="" disabled />);
    expect(runtime.release).toHaveBeenCalled();
  });

  it('hides the WLED security link in hotspot mode, where a browser would not reach 4.3.2.1', async () => {
    render(<WledBluetoothInstaller url="" disabled={false} />);
    await startHotspot();
    act(() => runtime.publish!({ stage: 'blocked', error: 'locked' }));
    expect(screen.getByText('sprayLed.installer.hotspot.locked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sprayLed.installer.securitySettings' })).toBeNull();
  });
});
