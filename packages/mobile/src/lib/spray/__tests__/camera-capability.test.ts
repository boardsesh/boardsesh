import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads the BINARY's version and the DEVICE's camera at call time;
// both are hoisted getters so a case can set them before asking. The pure
// comparison and the hardware rule below are what this file pins, so the real
// native modules stay stubbed out of the way.
const binary = vi.hoisted(() => ({ version: '2.6.0' as string | null, isDevice: true }));
vi.mock('expo-application', () => ({
  get nativeApplicationVersion() {
    return binary.version;
  },
  nativeBuildVersion: '1',
}));
vi.mock('expo-device', () => ({
  get isDevice() {
    return binary.isDevice;
  },
}));
import {
  canPhotographWall,
  FIRST_VERSION_WITH_WALL_CAMERA,
  hasUsableCameraSource,
  supportsWallCamera,
} from '../camera-capability';

beforeEach(() => {
  binary.version = '2.6.0';
  binary.isDevice = true;
});

describe('supportsWallCamera', () => {
  it('allows the version that first shipped the permission', () => {
    expect(supportsWallCamera(FIRST_VERSION_WITH_WALL_CAMERA)).toBe(true);
  });

  it('allows anything newer', () => {
    expect(supportsWallCamera('2.6.1')).toBe(true);
    expect(supportsWallCamera('2.7.0')).toBe(true);
    expect(supportsWallCamera('3.0.0')).toBe(true);
  });

  it('refuses the binaries that predate it', () => {
    expect(supportsWallCamera('2.5.0')).toBe(false);
    expect(supportsWallCamera('2.5.9')).toBe(false);
    expect(supportsWallCamera('1.9.9')).toBe(false);
  });

  it('refuses anything it cannot read', () => {
    // Every unknown is "too old" on purpose: hiding the button costs one tap
    // through the library, and offering it on a binary with no usage description
    // terminates iOS rather than being denied.
    expect(supportsWallCamera(null)).toBe(false);
    expect(supportsWallCamera(undefined)).toBe(false);
    expect(supportsWallCamera('')).toBe(false);
    expect(supportsWallCamera('nightly')).toBe(false);
    expect(supportsWallCamera('2.6.0-beta.1')).toBe(false);
    expect(supportsWallCamera('2.6.0.1')).toBe(false);
  });

  it('treats a short version as zero-padded', () => {
    expect(supportsWallCamera('3', '2.6.0')).toBe(true);
    expect(supportsWallCamera('2.6', '2.6.0')).toBe(true);
    expect(supportsWallCamera('2.5', '2.6.0')).toBe(false);
  });
});

describe('hasUsableCameraSource', () => {
  it('keeps the camera on a real iOS device', () => {
    expect(hasUsableCameraSource('ios', true)).toBe(true);
  });

  it('refuses the iOS simulator, whose camera source aborts the process', () => {
    // #6050: expo-image-picker sets `sourceType = .camera` unguarded, and an
    // ObjC exception from UIImagePickerController is not catchable in JS.
    expect(hasUsableCameraSource('ios', false)).toBe(false);
  });

  it('keeps the camera on Android even in an emulator', () => {
    // Android has no abort to dodge — a picker with nothing to launch rejects
    // into the promise — and the emulator's virtual camera is a QA path, so
    // only the iOS exclusion applies.
    expect(hasUsableCameraSource('android', false)).toBe(true);
    expect(hasUsableCameraSource('android', true)).toBe(true);
  });

  it('keeps the camera where the OS is not iOS', () => {
    expect(hasUsableCameraSource('web', true)).toBe(true);
    expect(hasUsableCameraSource('macos', true)).toBe(true);
  });
});

describe('canPhotographWall', () => {
  it('refuses the iOS simulator even on a binary the version gate vouches for', () => {
    binary.version = FIRST_VERSION_WITH_WALL_CAMERA;
    binary.isDevice = false;
    expect(canPhotographWall('ios')).toBe(false);
  });

  it('allows a real iOS device on a vouched binary', () => {
    binary.version = FIRST_VERSION_WITH_WALL_CAMERA;
    binary.isDevice = true;
    expect(canPhotographWall('ios')).toBe(true);
  });

  it('refuses an old binary wherever it runs', () => {
    // The permission gate stays first: on a 2.5.x binary the camera was never
    // an option, device or simulator alike.
    binary.version = '2.5.0';
    binary.isDevice = true;
    expect(canPhotographWall('ios')).toBe(false);
    binary.isDevice = false;
    expect(canPhotographWall('ios')).toBe(false);
  });

  it('keeps the Android emulator, which has a virtual camera', () => {
    binary.version = FIRST_VERSION_WITH_WALL_CAMERA;
    binary.isDevice = false;
    expect(canPhotographWall('android')).toBe(true);
  });

  it('refuses a binary whose version cannot be read', () => {
    // The asymmetric-cost rule from `supportsWallCamera` holds through the
    // composition: unknown means no button.
    binary.version = null;
    binary.isDevice = true;
    expect(canPhotographWall('ios')).toBe(false);
  });
});
