export type ClimbOverlayGPUFailureScope = 'frame' | 'static' | 'context';
export type ClimbOverlayGPUFailure = {
  requestId: string;
  reason: string;
  failureScope?: ClimbOverlayGPUFailureScope;
};

function readApiVersion(): number {
  try {
    // Read the existing public module constant without changing the local
    // native module's fingerprinted source tree. This safety layer can use OTA.
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    const nativeModule = requireOptionalNativeModule<{ apiVersion?: unknown }>('ClimbOverlayGPU');
    const apiVersion = nativeModule?.apiVersion;
    return typeof apiVersion === 'number' && Number.isSafeInteger(apiVersion) && apiVersion > 0
      ? apiVersion
      : nativeModule
        ? 1
        : 0;
  } catch {
    return 0;
  }
}

export const climbOverlayGpuApiVersion = readApiVersion();

/**
 * 1 when the native view takes each wall-swap frame as the `swapFrame` view
 * command (#7737), else 0. An older binary drops an unknown command without a
 * word, so this constant, not the API version, decides whether to send one.
 */
function readSwapCommandApi(): number {
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    const swapCommandApi = requireOptionalNativeModule<{ swapCommandApi?: unknown }>('ClimbOverlayGPU')?.swapCommandApi;
    return typeof swapCommandApi === 'number' && Number.isSafeInteger(swapCommandApi) && swapCommandApi > 0
      ? swapCommandApi
      : 0;
  } catch {
    return 0;
  }
}

export const climbOverlaySwapCommandApi = readSwapCommandApi();
