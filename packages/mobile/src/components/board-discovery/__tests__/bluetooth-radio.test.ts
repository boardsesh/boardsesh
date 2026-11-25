import { beforeEach, describe, expect, it, vi } from 'vitest';

// The way out of "Bluetooth is off": what each platform offers, what Turn on
// Bluetooth sends, and the one scan the radio coming on is allowed to start.

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' | 'web' }));
const linking = vi.hoisted(() => ({ sendIntent: vi.fn(async (_action: string) => {}) }));
vi.mock('react-native', () => ({
  get Platform() {
    return { OS: platform.OS };
  },
  Linking: linking,
}));

const settings = vi.hoisted(() => ({ openAppSettings: vi.fn(async () => true) }));
vi.mock('../../../lib/open-app-settings', () => settings);

type StateListener = (radioState: string) => void;
const radio = vi.hoisted(() => ({
  state: 'PoweredOff',
  listeners: [] as StateListener[],
  emitCurrentState: [] as boolean[],
  removed: 0,
}));
vi.mock('../../../lib/ble/ble-manager', () => ({
  getBleManager: () => ({
    state: async () => radio.state,
    onStateChange: (listener: StateListener, emitCurrentState: boolean) => {
      radio.listeners.push(listener);
      radio.emitCurrentState.push(emitCurrentState);
      return {
        remove: () => {
          radio.removed += 1;
          radio.listeners = radio.listeners.filter((registered) => registered !== listener);
        },
      };
    },
  }),
}));

const { bluetoothOffFix, isBluetoothPoweredOn, turnOnBluetooth, watchBluetoothPoweredOn } =
  await import('../bluetooth-radio');

function emit(radioState: string) {
  for (const listener of radio.listeners.slice()) listener(radioState);
}

async function settle() {
  await vi.waitFor(() => expect(radio.listeners.length).toBeGreaterThan(0));
}

beforeEach(() => {
  platform.OS = 'android';
  linking.sendIntent.mockReset().mockResolvedValue(undefined);
  settings.openAppSettings.mockClear();
  radio.state = 'PoweredOff';
  radio.listeners = [];
  radio.emitCurrentState = [];
  radio.removed = 0;
});

describe('bluetoothOffFix', () => {
  it.each([
    { os: 'android', fix: 'turn_on' },
    { os: 'ios', fix: 'control_center' },
    { os: 'web', fix: 'control_center' },
  ])('$os offers $fix', ({ os, fix }) => {
    expect(bluetoothOffFix(os)).toBe(fix);
  });
});

describe('turnOnBluetooth', () => {
  it("opens Android's own Turn on dialog", async () => {
    await expect(turnOnBluetooth()).resolves.toBe('asked');
    expect(linking.sendIntent.mock.calls).toEqual([['android.bluetooth.adapter.action.REQUEST_ENABLE']]);
  });

  it('falls back to the Bluetooth settings page when the dialog cannot open', async () => {
    linking.sendIntent.mockRejectedValueOnce(new Error('no activity'));
    await expect(turnOnBluetooth()).resolves.toBe('asked');
    expect(linking.sendIntent.mock.calls.map(([action]) => action)).toEqual([
      'android.bluetooth.adapter.action.REQUEST_ENABLE',
      'android.settings.BLUETOOTH_SETTINGS',
    ]);
  });

  it("opens the app's settings when neither Bluetooth page opens, and never throws", async () => {
    linking.sendIntent.mockRejectedValue(new Error('no activity'));
    await expect(turnOnBluetooth()).resolves.toBe('asked');
    expect(settings.openAppSettings).toHaveBeenCalledOnce();
  });

  it("leaves the app's settings alone when the dialog opened", async () => {
    await turnOnBluetooth();
    expect(settings.openAppSettings).not.toHaveBeenCalled();
  });

  it('says the radio is already on rather than show a dialog with nothing to do', async () => {
    radio.state = 'PoweredOn';
    await expect(turnOnBluetooth()).resolves.toBe('already_on');
    expect(linking.sendIntent).not.toHaveBeenCalled();
  });

  it('sends nothing on iOS, which has no way to turn it on', async () => {
    platform.OS = 'ios';
    await expect(turnOnBluetooth()).resolves.toBe('asked');
    expect(linking.sendIntent).not.toHaveBeenCalled();
  });
});

describe('isBluetoothPoweredOn', () => {
  it.each([
    { radioState: 'PoweredOn', poweredOn: true },
    { radioState: 'PoweredOff', poweredOn: false },
    { radioState: 'Resetting', poweredOn: false },
  ])('$radioState reads $poweredOn', async ({ radioState, poweredOn }) => {
    radio.state = radioState;
    await expect(isBluetoothPoweredOn()).resolves.toBe(poweredOn);
  });
});

describe('watchBluetoothPoweredOn', () => {
  it('calls once when the radio came on before the subscription took', async () => {
    radio.state = 'PoweredOn';
    const onPoweredOn = vi.fn();
    watchBluetoothPoweredOn(onPoweredOn);
    await vi.waitFor(() => expect(onPoweredOn).toHaveBeenCalledOnce());
    emit('PoweredOn');
    expect(onPoweredOn).toHaveBeenCalledOnce();
  });

  it('calls once, when the radio comes on, and not while it reads off', async () => {
    const onPoweredOn = vi.fn();
    const stop = watchBluetoothPoweredOn(onPoweredOn);
    await settle();
    expect(radio.emitCurrentState).toEqual([false]);

    emit('Resetting');
    emit('PoweredOff');
    expect(onPoweredOn).not.toHaveBeenCalled();
    emit('PoweredOn');
    expect(onPoweredOn).toHaveBeenCalledOnce();
    // It stops listening as it fires.
    expect(radio.removed).toBe(1);
    expect(radio.listeners).toEqual([]);
    emit('PoweredOn');
    expect(onPoweredOn).toHaveBeenCalledOnce();
    stop();
    expect(radio.removed).toBe(1);
  });

  it('calls nothing once stopped', async () => {
    const onPoweredOn = vi.fn();
    const stop = watchBluetoothPoweredOn(onPoweredOn);
    await settle();
    stop();
    emit('PoweredOn');
    expect(onPoweredOn).not.toHaveBeenCalled();
  });

  it('never listens when stopped before the manager loads', async () => {
    const onPoweredOn = vi.fn();
    watchBluetoothPoweredOn(onPoweredOn)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(radio.listeners).toEqual([]);
  });
});
