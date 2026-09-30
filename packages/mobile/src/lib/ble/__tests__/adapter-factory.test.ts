import Module from 'node:module';
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
}));

vi.mock('react-native', () => ({
  get Platform() {
    return harness.platform;
  },
}));

vi.mock('../adapter', () => ({ RNBleAdapter: harness.RNBleAdapter }));
vi.mock('../native-ios-adapter', () => ({
  NativeIosBleAdapter: harness.NativeIosBleAdapter,
  nativeBleSupportsConnectionAdoption: vi.fn(() => false),
  nativeBleSupportsBoard: harness.nativeBleSupportsBoard,
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
  getNativeBleConnectedDevice,
  isNativeIosBleAdapter,
  subscribeNativeBleConnected,
} from '../adapter-factory';
import * as screenshotFakeAdapterModule from '../screenshot-fake-adapter';

const { ScreenshotFakeBleAdapter } = screenshotFakeAdapterModule;

const noopPicker = () => Promise.resolve('');

beforeEach(() => {
  RNBleAdapter.mockClear();
  NativeIosBleAdapter.mockClear();
  harness.nativeBleSupportsBoard.mockReset();
  harness.nativeBleSupportsBoard.mockReturnValue(true);
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
    expect(NativeIosBleAdapter).not.toHaveBeenCalled();
  });

  it('always returns RNBleAdapter on Android, even with native module present', () => {
    platformMock.OS = 'android';
    harness.module.boardBleNative = { _placeholder: true };
    createBluetoothAdapter(noopPicker, 'aurora');
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
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
    expect(RNBleAdapter).toHaveBeenCalledWith(noopPicker, 'moonboard', options);
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

describe('screenshot fake-Bluetooth gate', () => {
  // The factory `require`s the fake adapter inside its gated branch so Metro
  // drops the module from normal builds. Under vitest that call reaches Node's
  // CommonJS loader, which can't resolve an extensionless `.ts` path; hand it
  // the module this file already imported (the same class, so instanceof holds).
  // Every other request goes to the real loader.
  type RequireFn = typeof Module.prototype.require;
  const realRequire = Object.getOwnPropertyDescriptor(Module.prototype, 'require')?.value as RequireFn;
  const requireSpy = vi.fn();
  beforeEach(() => {
    requireSpy.mockClear();
    Module.prototype.require = function (this: Module, id: string) {
      if (id === './screenshot-fake-adapter') {
        requireSpy(id);
        return screenshotFakeAdapterModule;
      }
      return realRequire.call(this, id);
    } as RequireFn;
  });

  afterEach(() => {
    Module.prototype.require = realRequire;
    vi.unstubAllEnvs();
  });

  const nativeWithAdoption = () => ({
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getConnectedDevice: vi.fn(async () => ({ deviceId: 'real-board', name: 'Kilter Board#1@3' })),
  });

  it.each([
    ['neither flag', undefined, undefined],
    ['screenshot mode alone', '1', undefined],
    ['fake BLE without screenshot mode', undefined, '1'],
    ['a fake-BLE value other than 1', '1', 'true'],
  ])('returns the real adapters with %s', (_label, screenshotMode, fakeBle) => {
    if (screenshotMode !== undefined) vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    if (fakeBle !== undefined) vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', fakeBle);
    platformMock.OS = 'ios';
    harness.module.boardBleNative = { _placeholder: true };
    const iosAdapter = createBluetoothAdapter(noopPicker, 'aurora');
    platformMock.OS = 'android';
    const androidAdapter = createBluetoothAdapter(noopPicker, 'aurora');

    expect(iosAdapter).not.toBeInstanceOf(ScreenshotFakeBleAdapter);
    expect(androidAdapter).not.toBeInstanceOf(ScreenshotFakeBleAdapter);
    // The fake module is only loaded inside the gated branch.
    expect(requireSpy).not.toHaveBeenCalled();
    expect(NativeIosBleAdapter).toHaveBeenCalledTimes(1);
    expect(RNBleAdapter).toHaveBeenCalledTimes(1);
  });

  it('returns the fake adapter on both platforms when both flags are 1', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    harness.module.boardBleNative = { _placeholder: true };

    platformMock.OS = 'ios';
    const iosAdapter = createBluetoothAdapter(noopPicker, 'aurora', { boardName: 'kilter' });
    platformMock.OS = 'android';
    const androidAdapter = createBluetoothAdapter(noopPicker, 'moonboard', { boardName: 'moonboard' });

    expect(iosAdapter).toBeInstanceOf(ScreenshotFakeBleAdapter);
    expect(androidAdapter).toBeInstanceOf(ScreenshotFakeBleAdapter);
    expect(isNativeIosBleAdapter(iosAdapter)).toBe(false);
    expect(NativeIosBleAdapter).not.toHaveBeenCalled();
    expect(RNBleAdapter).not.toHaveBeenCalled();
  });

  it('turns native connection adoption off only when both flags are 1', async () => {
    const native = nativeWithAdoption();
    harness.module.boardBleNative = native;
    expect(await getNativeBleConnectedDevice()).toEqual({ deviceId: 'real-board', name: 'Kilter Board#1@3' });

    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    expect(subscribeNativeBleConnected(vi.fn())).toBeNull();
    expect(await getNativeBleConnectedDevice()).toBeNull();
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.getConnectedDevice).toHaveBeenCalledTimes(1);
  });
});
