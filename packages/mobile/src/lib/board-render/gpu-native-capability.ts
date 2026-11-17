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
