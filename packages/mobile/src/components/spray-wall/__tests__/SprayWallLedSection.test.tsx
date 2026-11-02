// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedControllerError, type LedControllerInfo } from '@boardsesh/led-controller';
import type { SprayWallLedSettings } from '../../../lib/spray/use-spray-wall-led-settings';

const controller = vi.hoisted(() => ({ probe: vi.fn(), lightAll: vi.fn(), turnOff: vi.fn() }));
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), records: new Map<string, unknown>() }));

vi.mock('@boardsesh/led-controller', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/led-controller')>()),
  getLedControllerDriver: () => controller,
}));
vi.mock('../../../lib/preference-store', () => ({
  getPreference: storage.read,
  setPreference: storage.write,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666' },
    brandColors: { error: '#900' },
    spacing: [0, 4, 8, 12, 16, 20],
  }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState.expanded },
      children,
    ),
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
    onValueChange: (enabled: boolean) => void;
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
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  SectionLabel: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  BuilderTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    value: string;
    onChangeText: (url: string) => void;
    accessibilityLabel: string;
    editable: boolean;
  }) =>
    createElement('input', {
      value,
      'aria-label': accessibilityLabel,
      disabled: !editable,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));

import { SprayWallLedSection } from '../SprayWallLedSection';

const settingsKey = 'sprayWallLedSettings:wall-1';
const controllerInfo: LedControllerInfo = { name: 'Home wall', version: '0.15.2', ledCount: 180 };
const savedSettings = (enabled = true, url = ''): SprayWallLedSettings => ({
  version: 1,
  enabled,
  controller: { type: 'wled', url },
});
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const button = (key: string) => screen.getByRole('button', { name: `sprayLed.${key}` });
const enabledSwitch = () => screen.getByRole('switch', { name: 'sprayLed.enable' }) as HTMLInputElement;
const urlInput = () => screen.getByRole('textbox', { name: 'sprayLed.url' }) as HTMLInputElement;
function enterUrl(url: string) {
  fireEvent.change(urlInput(), { target: { value: url } });
}
async function openSection() {
  fireEvent.click(button('title'));
  await waitFor(() => expect(enabledSwitch().disabled).toBe(false));
}
async function connect(url = 'wled.local') {
  enterUrl(url);
  fireEvent.click(button('confirm'));
  await waitFor(() => expect(screen.queryByText('sprayLed.saved')).not.toBeNull());
  await waitFor(() => expect((button('lightAll') as HTMLButtonElement).disabled).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.records.clear();
  storage.read.mockReset().mockImplementation(async (key: string) => storage.records.get(key) ?? null);
  storage.write.mockReset().mockImplementation(async (key: string, settings: unknown) => {
    storage.records.set(key, settings);
  });
  controller.probe.mockReset().mockResolvedValue(controllerInfo);
  controller.lightAll.mockReset().mockResolvedValue(undefined);
  controller.turnOff.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('SprayWallLedSection', () => {
  it('starts collapsed and disabled, without contacting or lighting a controller', async () => {
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    expect(button('title').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('switch')).toBeNull();
    await openSection();
    expect(enabledSwitch().checked).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sprayLed.setup' })).toBeNull();
    expect(controller.probe).not.toHaveBeenCalled();
    expect(controller.lightAll).not.toHaveBeenCalled();
    expect(controller.turnOff).not.toHaveBeenCalled();
  });

  it('retains the confirmed URL when disabled, re-enabled, and reopened', async () => {
    const view = render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    fireEvent.click(enabledSwitch());
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeNull());
    await connect('http://192.168.1.20/');
    expect(urlInput().value).toBe('http://192.168.1.20');
    fireEvent.click(enabledSwitch());
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(storage.records.get(settingsKey)).toEqual(savedSettings(false, 'http://192.168.1.20'));
    fireEvent.click(enabledSwitch());
    await waitFor(() => expect(urlInput().value).toBe('http://192.168.1.20'));
    view.unmount();
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    expect(urlInput().value).toBe('http://192.168.1.20');
    expect(controller.probe).toHaveBeenCalledTimes(1);
    expect(controller.lightAll).not.toHaveBeenCalled();
    expect(controller.turnOff).not.toHaveBeenCalled();
  });

  it('only tests on OK, saves the normalized address, and leaves lighting to a separate tap', async () => {
    storage.records.set(settingsKey, savedSettings());
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    enterUrl('wled.local');
    expect(controller.probe).not.toHaveBeenCalled();
    fireEvent.click(button('confirm'));
    await waitFor(() => expect(storage.records.get(settingsKey)).toEqual(savedSettings(true, 'http://wled.local')));
    expect(screen.queryByText('sprayLed.connected')).not.toBeNull();
    expect(controller.probe).toHaveBeenCalledWith('http://wled.local', expect.any(AbortSignal));
    expect(controller.lightAll).not.toHaveBeenCalled();
    fireEvent.click(button('lightAll'));
    await waitFor(() => expect(screen.queryByText('sprayLed.lit')).not.toBeNull());
    expect(controller.lightAll).toHaveBeenCalledWith('http://wled.local', expect.any(AbortSignal));
    fireEvent.click(button('turnOff'));
    await waitFor(() => expect(screen.queryByText('sprayLed.off')).not.toBeNull());
    expect(controller.turnOff).toHaveBeenCalledTimes(1);
  });

  it.each(['unavailable', 'timeout', 'not-wled'] as const)(
    'keeps a %s address only after the explicit keep action',
    async (code) => {
      storage.records.set(settingsKey, savedSettings(true, 'http://previous.local'));
      controller.probe.mockRejectedValueOnce(new LedControllerError(code));
      render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
      await openSection();
      enterUrl('offline.local');
      fireEvent.click(button('confirm'));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'sprayLed.keepUrl' })).not.toBeNull());
      expect(storage.records.get(settingsKey)).toEqual(savedSettings(true, 'http://previous.local'));
      expect(screen.queryByRole('button', { name: 'sprayLed.lightAll' })).toBeNull();
      fireEvent.click(button('keepUrl'));
      await waitFor(() =>
        expect(storage.records.get(settingsKey)).toEqual(savedSettings(true, 'http://offline.local')),
      );
      expect(screen.queryByText('sprayLed.saved')).not.toBeNull();
      expect(controller.lightAll).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed URL without network traffic or overwriting the saved address', async () => {
    storage.records.set(settingsKey, savedSettings(true, 'http://previous.local'));
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    enterUrl('https://');
    fireEvent.click(button('confirm'));
    expect(screen.queryByText('sprayLed.invalidUrl')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'sprayLed.keepUrl' })).toBeNull();
    expect(storage.write).not.toHaveBeenCalled();
    expect(controller.probe).not.toHaveBeenCalled();
  });

  it('ignores an old successful probe after the user changes the address', async () => {
    storage.records.set(settingsKey, savedSettings());
    const oldProbe = deferred<LedControllerInfo>();
    controller.probe.mockReturnValueOnce(oldProbe.promise);
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    enterUrl('old.local');
    fireEvent.click(button('confirm'));
    const oldSignal = controller.probe.mock.calls[0][1] as AbortSignal;
    enterUrl('new.local');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      oldProbe.resolve(controllerInfo);
    });
    expect(screen.queryByText('sprayLed.connected')).toBeNull();
    expect(storage.write).not.toHaveBeenCalled();
    expect(urlInput().value).toBe('new.local');
    await connect('new.local');
    expect(storage.records.get(settingsKey)).toEqual(savedSettings(true, 'http://new.local'));
  });

  it.each(['collapse', 'disable', 'unmount'] as const)(
    'cancels an in-flight probe on %s without applying its late result',
    async (action) => {
      storage.records.set(settingsKey, savedSettings());
      const probe = deferred<LedControllerInfo>();
      controller.probe.mockReturnValueOnce(probe.promise);
      const view = render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
      await openSection();
      enterUrl('wled.local');
      fireEvent.click(button('confirm'));
      const signal = controller.probe.mock.calls[0][1] as AbortSignal;
      if (action === 'collapse') fireEvent.click(button('title'));
      if (action === 'disable') fireEvent.click(enabledSwitch());
      if (action === 'unmount') view.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => {
        probe.resolve(controllerInfo);
      });
      expect(screen.queryByText('sprayLed.connected')).toBeNull();
      expect(storage.records.get(settingsKey)).toEqual(savedSettings(action !== 'disable'));
    },
  );

  it('shows a lighting failure and permits retry without duplicate in-flight commands', async () => {
    storage.records.set(settingsKey, savedSettings());
    const command = deferred<void>();
    controller.lightAll.mockReturnValueOnce(command.promise);
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    await connect();
    fireEvent.click(button('lightAll'));
    fireEvent.click(button('lightAll'));
    expect(controller.lightAll).toHaveBeenCalledTimes(1);
    await act(async () => {
      command.reject(new LedControllerError('command-failed'));
    });
    expect(screen.queryByText('sprayLed.lightFailed')).not.toBeNull();
    fireEvent.click(button('lightAll'));
    await waitFor(() => expect(screen.queryByText('sprayLed.lit')).not.toBeNull());
    expect(controller.lightAll).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh editor when changing walls and discards the old connection result', async () => {
    storage.records.set(settingsKey, savedSettings());
    storage.records.set('sprayWallLedSettings:wall-2', savedSettings(true, 'http://second.local'));
    const probe = deferred<LedControllerInfo>();
    controller.probe.mockReturnValueOnce(probe.promise);
    const view = render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    enterUrl('first.local');
    fireEvent.click(button('confirm'));
    const signal = controller.probe.mock.calls[0][1] as AbortSignal;
    view.rerender(createElement(SprayWallLedSection, { wallUuid: 'wall-2' }));
    expect(signal.aborted).toBe(true);
    expect(button('title').getAttribute('aria-expanded')).toBe('false');
    await openSection();
    expect(urlInput().value).toBe('http://second.local');
    await act(async () => {
      probe.resolve(controllerInfo);
    });
    expect(screen.queryByText('sprayLed.connected')).toBeNull();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('shows storage failures and retries without claiming the URL was saved', async () => {
    storage.records.set(settingsKey, savedSettings());
    storage.write.mockRejectedValueOnce(new Error('Storage unavailable'));
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    await openSection();
    enterUrl('wled.local');
    fireEvent.click(button('confirm'));
    await waitFor(() => expect(screen.queryByText('sprayLed.saveFailed')).not.toBeNull());
    expect(screen.queryByText('sprayLed.saved')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sprayLed.lightAll' })).toBeNull();
    await connect();
    expect(storage.records.get(settingsKey)).toEqual(savedSettings(true, 'http://wled.local'));
  });

  it('allows retrying a failed settings read and opens the setup placeholder without contacting WLED', async () => {
    storage.records.set(settingsKey, savedSettings());
    storage.read.mockRejectedValueOnce(new Error('Storage unavailable'));
    render(createElement(SprayWallLedSection, { wallUuid: 'wall-1' }));
    fireEvent.click(button('title'));
    await waitFor(() => expect(screen.queryByText('sprayLed.loadFailed')).not.toBeNull());
    expect(enabledSwitch().disabled).toBe(true);
    fireEvent.click(button('retry'));
    await waitFor(() => expect(enabledSwitch().disabled).toBe(false));
    fireEvent.click(button('setup'));
    expect(screen.queryByText('sprayLed.setupPending')).not.toBeNull();
    expect(controller.probe).not.toHaveBeenCalled();
    expect(controller.lightAll).not.toHaveBeenCalled();
  });
});
