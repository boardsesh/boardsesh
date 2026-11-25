// The in-app "Scan a board code" camera, reached only through this file.
//
// OTA safety. expo-camera is a native module that first ships in the store
// build this file arrived with. A JavaScript bundle built from this file also
// reaches every older binary through OTA, and importing `expo-camera` there
// runs `requireNativeModule('ExpoCamera')`, which throws. So nothing imports
// expo-camera at the top of a file: the availability check asks
// `requireOptionalNativeModule`, which answers null instead of throwing, and
// expo-camera itself is required only once that check has found the module.
// On an older binary the Scan button stays hidden and the scan route says the
// app needs updating. The browser build has its own fork that always says no
// (camera-module.web.ts), so expo-camera and its WebAssembly barcode reader
// never reach the Expo web bundle.

import type * as ExpoCameraModule from 'expo-camera';
import type * as ExpoModulesCore from 'expo-modules-core';

/** The parts of expo-camera the scanner uses. */
export type BoardCodeCamera = Pick<typeof ExpoCameraModule, 'CameraView' | 'useCameraPermissions'>;

/**
 * Where the scanner reaches the native side. Tests swap it: Vitest cannot mock
 * a `require`, and the real module cannot load outside a binary.
 */
export type CameraNativeBindings = {
  /** Whether this binary links the ExpoCamera native module. */
  hasExpoCamera(): boolean;
  /** expo-camera itself. Only once `hasExpoCamera()` is true: its import throws without the module. */
  loadExpoCamera(): BoardCodeCamera;
};

const NATIVE_BINDINGS: CameraNativeBindings = {
  hasExpoCamera() {
    // oxlint-disable-next-line import/no-commonjs
    const modulesCore = require('expo-modules-core') as typeof ExpoModulesCore;
    return modulesCore.requireOptionalNativeModule('ExpoCamera') !== null;
  },
  loadExpoCamera() {
    // oxlint-disable-next-line import/no-commonjs
    return require('expo-camera') as BoardCodeCamera;
  },
};

let bindings: CameraNativeBindings = NATIVE_BINDINGS;
// `undefined` = not asked yet. Neither answer can change within an app run.
let hasCameraModule: boolean | undefined;
let loadedCamera: BoardCodeCamera | null | undefined;

/**
 * Whether this binary can scan a board code: shows or hides the Scan button.
 * Asks the native side only, so the screen that shows the button never loads
 * expo-camera's JavaScript; that waits for the scan screen.
 */
export function isBoardCodeScannerAvailable(): boolean {
  if (hasCameraModule !== undefined) return hasCameraModule;
  try {
    hasCameraModule = bindings.hasExpoCamera();
  } catch {
    hasCameraModule = false;
  }
  return hasCameraModule;
}

/** expo-camera, or null when this binary has no camera module (an older store build). */
export function loadBoardCodeCamera(): BoardCodeCamera | null {
  if (loadedCamera !== undefined) return loadedCamera;
  try {
    loadedCamera = isBoardCodeScannerAvailable() ? bindings.loadExpoCamera() : null;
  } catch {
    loadedCamera = null;
  }
  return loadedCamera;
}

/** Tests only: swap the native side and forget the cached answers. */
export function setCameraNativeBindingsForTests(next: CameraNativeBindings | null): void {
  bindings = next ?? NATIVE_BINDINGS;
  hasCameraModule = undefined;
  loadedCamera = undefined;
}
