import { Platform } from 'react-native';

/**
 * Where the native frost can run: iOS, and Android 13+ (its AGSL renderer
 * needs API 33). Never resolve the native view anywhere else.
 */
export function frostedBokehPlatformSupported(): boolean {
  return Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 33);
}

/** A module's `swapFrameApi` constant: a positive integer, else 0. */
export function swapFrameApiOf(nativeModule: { swapFrameApi?: unknown } | null | undefined): number {
  const constant = nativeModule?.swapFrameApi;
  return typeof constant === 'number' && Number.isSafeInteger(constant) && constant > 0 ? constant : 0;
}

/**
 * The frost's `swapFrameApi` without importing the native view: for code that
 * only decides whether to prepare the frost's inputs (`PlayCore`), so it pulls
 * in no view manager. 0 off the supported platforms, on older binaries and
 * wherever the module cannot be read.
 */
export function readFrostedBokehSwapFrameApi(): number {
  if (!frostedBokehPlatformSupported()) return 0;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    return swapFrameApiOf(requireOptionalNativeModule<{ swapFrameApi?: unknown }>('FrostedBokehGPU'));
  } catch {
    return 0;
  }
}
