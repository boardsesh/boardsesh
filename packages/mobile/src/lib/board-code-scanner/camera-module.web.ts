// The browser build never scans: the Scan button stays hidden, and expo-camera
// with its WebAssembly barcode reader stays out of the Expo web bundle. The
// native file explains the guard (camera-module.ts).

import type { BoardCodeCamera, CameraNativeBindings } from './camera-module';

export type { BoardCodeCamera, CameraNativeBindings };

export function loadBoardCodeCamera(): BoardCodeCamera | null {
  return null;
}

export function isBoardCodeScannerAvailable(): boolean {
  return false;
}

export function setCameraNativeBindingsForTests(_next: CameraNativeBindings | null): void {}
