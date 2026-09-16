import { describe, expect, it, vi } from 'vitest';

// The module reads the BINARY's version at import time; the pure comparison
// below is what this file pins, so the native read is stubbed out of the way.
vi.mock('expo-application', () => ({ nativeApplicationVersion: '2.5.0', nativeBuildVersion: '1' }));
import { FIRST_VERSION_WITH_WALL_CAMERA, supportsWallCamera } from '../camera-capability';

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
