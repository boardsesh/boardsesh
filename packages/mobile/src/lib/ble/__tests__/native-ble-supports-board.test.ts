import { describe, it, expect, vi } from 'vitest';

// The #3314 binary-capability probe: JS rides OTA onto older binaries, so
// every native Woods behaviour is gated on the `nativeBoardControlBoards`
// constant the newer BoardBle module exports. These tests pin the fallback
// contract for binaries (and platforms) where the constant is absent.
const harness = vi.hoisted(() => ({
  module: { boardBleNative: null as { nativeBoardControlBoards?: unknown } | null },
}));

vi.mock('../../../../modules/live-activity/src/index', () => ({
  get boardBleNative() {
    return harness.module.boardBleNative;
  },
}));

import { nativeBleSupportsBoard } from '../native-ios-adapter';

describe('nativeBleSupportsBoard', () => {
  it('trusts the constant on binaries that export it', () => {
    harness.module.boardBleNative = {
      nativeBoardControlBoards: ['kilter', 'tension', 'moonboard', 'woods'],
    };
    expect(nativeBleSupportsBoard('woods')).toBe(true);
    expect(nativeBleSupportsBoard('kilter')).toBe(true);
    // A board JS knows about before any binary does falls back to ble-plx.
    expect(nativeBleSupportsBoard('futureboard')).toBe(false);
    expect(nativeBleSupportsBoard(undefined)).toBe(false);
  });

  it('treats an absent constant as the pre-#3314 surface: everything except Woods', () => {
    harness.module.boardBleNative = {};
    expect(nativeBleSupportsBoard('woods')).toBe(false);
    expect(nativeBleSupportsBoard('kilter')).toBe(true);
    expect(nativeBleSupportsBoard('moonboard')).toBe(true);
  });

  it('treats a null module (Android, Expo Go) the same as an absent constant', () => {
    harness.module.boardBleNative = null;
    expect(nativeBleSupportsBoard('woods')).toBe(false);
    expect(nativeBleSupportsBoard('tension')).toBe(true);
  });

  it('ignores a malformed constant rather than trusting it', () => {
    harness.module.boardBleNative = { nativeBoardControlBoards: 'woods' };
    expect(nativeBleSupportsBoard('woods')).toBe(false);
    expect(nativeBleSupportsBoard('kilter')).toBe(true);
  });
});
