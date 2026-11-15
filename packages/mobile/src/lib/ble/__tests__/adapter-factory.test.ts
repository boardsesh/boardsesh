import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// All mock state lives inside vi.hoisted so it's initialized before the
// vi.mock factories run (vi.mock is hoisted above regular top-level code).
const harness = vi.hoisted(() => ({
  platform: { OS: 'ios' as 'ios' | 'android' },
  // Use vi.fn(function () { ... }) so `new` works — arrow functions returned
  // from mockImplementation aren't constructable.
  RNBleAdapter: vi.fn(function (this: { kind: string }) {
    this.kind = 'rn';
  }),
  NativeIosBleAdapter: vi.fn(function (this: { kind: string }) {
    this.kind = 'native-ios';
  }),
  // boardBleNative is null when the native module isn't linked — fallback path.
  module: { boardBleNative: { _placeholder: true } as object | null },
  // The #3314 binary-capability probe. Its real per-binary behaviour is unit
  // tested in native-ble-supports-board.test.ts; here it's a switch for the
  // factory's routing decision.
  nativeBleSupportsBoard: vi.fn(() => true),
  nativeBleSupportsPreparedConnections: vi.fn(() => false),
  nativeBleSupportsConnectionAdoption: vi.fn(() => false),
}));

vi.mock('react-native', () => ({
  get Platform() {
    return harness.platform;
  },
}));

vi.mock('../adapter', () => ({ RNBleAdapter: harness.RNBleAdapter }));
vi.mock('../native-ios-adapter', () => ({
  NativeIosBleAdapter: harness.NativeIosBleAdapter,
  nativeBleSupportsConnectionAdoption: harness.nativeBleSupportsConnectionAdoption,
  nativeBleSupportsBoard: harness.nativeBleSupportsBoard,
  nativeBleSupportsPreparedConnections: harness.nativeBleSupportsPreparedConnections,
}));
vi.mock('../../../../modules/live-activity/src/index', () => ({
  get boardBleNative() {
    return harness.module.boardBleNative;
  },
}));

const platformMock = harness.platform;
const RNBleAdapter = harness.RNBleAdapter;
const NativeIosBleAdapter = harness.NativeIosBleAdapter;

import {
  createBluetoothAdapter,
  forgetNativeKeptBoard,
  getNativeBleConnectedDevice,
  isNativeIosBleAdapter,
  nativeBleSupportsPreparedConnections,
  subscribeNativeBleConnected,
} from '../adapter-factory';

const noopPicker = () => Promise.resolve('');

beforeEach(() => {
  RNBleAdapter.mockClear();
  NativeIosBleAdapter.mockClear();
  harness.nativeBleSupportsBoard.mockReset();
  harness.nativeBleSupportsBoard.mockReturnValue(true);
  harness.nativeBleSupportsConnectionAdoption.mockReset();
  harness.nativeBleSupportsConnectionAdoption.mockReturnValue(false);
});

describe('createBluetoothAdapter', () => {
  it('returns NativeIosBleAdapter on iOS when the native module is linked', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    createBluetoothAdapter(noopPicker, 'aurora');
    expect(NativeIosBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).not.toHaveBeenCalled();
  });

  it('falls back to RNBleAdapter on iOS when the native module is missing', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = null;
    createBluetoothAdapter(noopPicker, 'aurora');
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).toHaveBeenCalledWith(noopPicker, 'aurora', { enableAndroidConnectRetry: false });
    expect(NativeIosBleAdapter).not.toHaveBeenCalled();
  });

  it('always returns RNBleAdapter on Android, even with native module present', () => {
    platformMock.OS = 'android';
    harness.module.boardBleNative = { _placeholder: true };
    createBluetoothAdapter(noopPicker, 'aurora');
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).toHaveBeenCalledWith(noopPicker, 'aurora', { enableAndroidConnectRetry: true });
    expect(NativeIosBleAdapter).not.toHaveBeenCalled();
  });

  // A board that needs acknowledged writes (Woods, protocol spec §8) takes the
  // native path only when the running binary's Swift layer can drive it. An
  // old binary (probe false) hardcodes write-without-response for every
  // non-moonboard board and would encode Woods as Aurora, so it stays on
  // RNBleAdapter (#3314).
  it('returns RNBleAdapter on iOS for an acknowledged-writes board on a binary that cannot drive it', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    harness.nativeBleSupportsBoard.mockReturnValue(false);
    const options = { preferWriteWithResponse: true, boardName: 'woods' };
    createBluetoothAdapter(noopPicker, 'moonboard', options);
    expect(harness.nativeBleSupportsBoard).toHaveBeenCalledWith('woods');
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).toHaveBeenCalledWith(noopPicker, 'moonboard', {
      ...options,
      enableAndroidConnectRetry: false,
    });
    expect(NativeIosBleAdapter).not.toHaveBeenCalled();
  });

  it('returns NativeIosBleAdapter on iOS for an acknowledged-writes board on a binary that drives it', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    harness.nativeBleSupportsBoard.mockReturnValue(true);
    const options = { preferWriteWithResponse: true, boardName: 'woods' };
    createBluetoothAdapter(noopPicker, 'moonboard', options);
    expect(NativeIosBleAdapter).toHaveBeenCalledTimes(1);
    expect(NativeIosBleAdapter).toHaveBeenCalledWith(noopPicker, 'moonboard', options);
    expect(RNBleAdapter).not.toHaveBeenCalled();
  });

  it('still returns NativeIosBleAdapter on iOS when the board does not prefer acknowledged writes', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    // The probe is not even consulted on the proven default path.
    harness.nativeBleSupportsBoard.mockReturnValue(false);
    createBluetoothAdapter(noopPicker, 'moonboard', { preferWriteWithResponse: false });
    expect(harness.nativeBleSupportsBoard).not.toHaveBeenCalled();
    expect(NativeIosBleAdapter).toHaveBeenCalledTimes(1);
    expect(NativeIosBleAdapter).toHaveBeenCalledWith(noopPicker, 'moonboard', { preferWriteWithResponse: false });
    expect(RNBleAdapter).not.toHaveBeenCalled();
  });
});

describe('isNativeIosBleAdapter', () => {
  it('returns true for the mocked NativeIosBleAdapter instance, false for RN', () => {
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    const nativeInstance = createBluetoothAdapter(noopPicker, 'aurora');
    expect(NativeIosBleAdapter).toHaveBeenCalled();

    platformMock.OS = 'android';
    const rnInstance = createBluetoothAdapter(noopPicker, 'moonboard');
    expect(RNBleAdapter).toHaveBeenCalled();

    // The factory uses instanceof against the imported NativeIosBleAdapter
    // symbol; with mocked constructors that symbol IS the vi.fn class, so
    // instanceof works against fabricated instances. (The picker callback is
    // unused here — we're only checking the branching logic.)
    expect(isNativeIosBleAdapter(nativeInstance)).toBe(true);
    expect(isNativeIosBleAdapter(rnInstance)).toBe(false);
  });
});

it('exports the running binary prepared-connection capability', () => {
  harness.nativeBleSupportsPreparedConnections.mockReturnValueOnce(true);
  expect(nativeBleSupportsPreparedConnections()).toBe(true);
  expect(nativeBleSupportsPreparedConnections()).toBe(false);
});

// A hang-up keeps the iOS native pairing for 10 minutes; once JS forgets the
// board, this forgets the pairing so the Live Activity bulb can't reach it.
describe('forgetNativeKeptBoard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const nativeThatKeepsBoards = () => ({
    disconnect: vi.fn(async () => {}),
    disconnectKeepingBoard: vi.fn(async () => {}),
  });

  it('forgets the pairing with the plain native disconnect on iOS', async () => {
    platformMock.OS = 'ios';
    const native = nativeThatKeepsBoards();
    harness.module.boardBleNative = native;
    // True: the caller redraws the Live Activity card off the forgotten pairing.
    await expect(forgetNativeKeptBoard()).resolves.toBe(true);
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(native.disconnectKeepingBoard).not.toHaveBeenCalled();
  });

  it('does nothing on a binary that never keeps a board or on Android', async () => {
    const oldBinary = { disconnect: vi.fn(async () => {}) };
    platformMock.OS = 'ios';
    harness.module.boardBleNative = oldBinary;
    await expect(forgetNativeKeptBoard()).resolves.toBe(false);
    expect(oldBinary.disconnect).not.toHaveBeenCalled();

    const native = nativeThatKeepsBoards();
    harness.module.boardBleNative = native;
    platformMock.OS = 'android';
    await expect(forgetNativeKeptBoard()).resolves.toBe(false);
    expect(native.disconnect).not.toHaveBeenCalled();
  });

  it('swallows a native rejection', async () => {
    platformMock.OS = 'ios';
    const native = nativeThatKeepsBoards();
    native.disconnect.mockRejectedValue(new Error('BLE_DISCONNECT_FAILED'));
    harness.module.boardBleNative = native;
    await expect(forgetNativeKeptBoard()).resolves.toBe(false);
  });
});

describe('retired screenshot flags do not alter real Bluetooth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['neither flag', undefined, undefined],
    ['screenshot mode alone', '1', undefined],
    ['fake BLE without screenshot mode', undefined, '1'],
    ['a fake-BLE value other than 1', '1', 'true'],
    ['both retired flags', '1', '1'],
  ])('returns the real adapters with %s', (_label, screenshotMode, fakeBle) => {
    if (screenshotMode !== undefined) vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    if (fakeBle !== undefined) vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', fakeBle);
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    const iosAdapter = createBluetoothAdapter(noopPicker, 'aurora');
    platformMock.OS = 'android';
    const androidAdapter = createBluetoothAdapter(noopPicker, 'aurora');

    expect(isNativeIosBleAdapter(iosAdapter)).toBe(true);
    expect(isNativeIosBleAdapter(androidAdapter)).toBe(false);
    expect(NativeIosBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
  });

  it('preserves native connection adoption when both retired flags are set', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    const subscription = { remove: vi.fn() };
    const native = {
      addListener: vi.fn(() => subscription),
      getConnectedDevice: vi.fn(async () => ({ deviceId: 'real-board', name: 'Kilter Board#1@3' })),
    };
    harness.module.boardBleNative = native;
    harness.nativeBleSupportsConnectionAdoption.mockReturnValue(true);
    const listener = vi.fn();

    expect(subscribeNativeBleConnected(listener)).toBe(subscription);
    expect(native.addListener).toHaveBeenCalledWith('connected', listener);
    expect(await getNativeBleConnectedDevice()).toEqual({ deviceId: 'real-board', name: 'Kilter Board#1@3' });
    expect(native.getConnectedDevice).toHaveBeenCalledOnce();
  });

  it('forgets the native pairing when both retired flags are set', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    platformMock.OS = 'ios';
    const native = { disconnect: vi.fn(async () => {}), disconnectKeepingBoard: vi.fn(async () => {}) };
    harness.module.boardBleNative = native;

    await expect(forgetNativeKeptBoard()).resolves.toBe(true);
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(native.disconnectKeepingBoard).not.toHaveBeenCalled();
  });
});
