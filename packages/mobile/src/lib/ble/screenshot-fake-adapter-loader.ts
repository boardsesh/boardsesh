// Loads `ScreenshotFakeBleAdapter` for a fake-Bluetooth screenshot build, and
// nothing otherwise.
//
// The `require` sits inside the inlined env gate on purpose: in a normal build
// the condition folds to `false`, Metro drops the branch, and with it the
// dependency, so the fake adapter never ships. A top-level import would keep it
// in every bundle. Only its type is imported here.
//
// It lives in its own module so tests can `vi.mock` it: vitest can't intercept a
// CommonJS `require` of a `.ts` file.

import type { ScreenshotFakeBleAdapter } from './screenshot-fake-adapter';

export function loadScreenshotFakeAdapter(): typeof ScreenshotFakeBleAdapter | null {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // oxlint-disable-next-line import/no-commonjs
    const fakeAdapterModule = require('./screenshot-fake-adapter') as {
      ScreenshotFakeBleAdapter: typeof ScreenshotFakeBleAdapter;
    };
    return fakeAdapterModule.ScreenshotFakeBleAdapter;
  }
  return null;
}
