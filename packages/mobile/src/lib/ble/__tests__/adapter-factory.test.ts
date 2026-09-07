import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { createBluetoothAdapter, isNativeIosBleAdapter } from '../adapter-factory';

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
