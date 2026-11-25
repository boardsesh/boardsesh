import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBoardCodeScannerAvailable,
  loadBoardCodeCamera,
  setCameraNativeBindingsForTests,
  type BoardCodeCamera,
} from '../camera-module';

const FAKE_CAMERA = { CameraView: () => null, useCameraPermissions: () => [null] } as unknown as BoardCodeCamera;

afterEach(() => {
  setCameraNativeBindingsForTests(null);
});

describe('board code camera guard', () => {
  it('loads expo-camera when the binary links its native module', () => {
    const loadExpoCamera = vi.fn(() => FAKE_CAMERA);
    setCameraNativeBindingsForTests({ hasExpoCamera: () => true, loadExpoCamera });
    expect(isBoardCodeScannerAvailable()).toBe(true);
    expect(loadBoardCodeCamera()).toBe(FAKE_CAMERA);
    // Asked once per app run: the binary cannot gain or lose the module.
    expect(loadExpoCamera).toHaveBeenCalledTimes(1);
  });

  it('never requires expo-camera on an older binary, whose import would throw', () => {
    const loadExpoCamera = vi.fn(() => {
      throw new Error("Cannot find native module 'ExpoCamera'");
    });
    setCameraNativeBindingsForTests({ hasExpoCamera: () => false, loadExpoCamera });
    expect(isBoardCodeScannerAvailable()).toBe(false);
    expect(loadBoardCodeCamera()).toBeNull();
    expect(loadExpoCamera).not.toHaveBeenCalled();
  });

  it('hides the scanner when loading expo-camera throws anyway', () => {
    setCameraNativeBindingsForTests({
      hasExpoCamera: () => true,
      loadExpoCamera: () => {
        throw new Error('boom');
      },
    });
    expect(isBoardCodeScannerAvailable()).toBe(false);
  });

  it('hides the scanner when the availability check itself throws', () => {
    setCameraNativeBindingsForTests({
      hasExpoCamera: () => {
        throw new Error('expo-modules-core unavailable');
      },
      loadExpoCamera: () => FAKE_CAMERA,
    });
    expect(isBoardCodeScannerAvailable()).toBe(false);
  });
});

describe('board code camera guard on the browser', () => {
  it('never scans in the Expo web app', async () => {
    const web = await import('../camera-module.web');
    expect(web.isBoardCodeScannerAvailable()).toBe(false);
    expect(web.loadBoardCodeCamera()).toBeNull();
  });
});
