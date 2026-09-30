import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeDiagnostics = {
  nativeInitVersion: number;
  nativeStartupId?: string;
  previousNativeStartupId?: string;
  crashNativeAbort?: () => void;
};
// This module loads no renderer/FFI library: safe before Sentry initialization.
export const nativeMobileDiagnostics = requireOptionalNativeModule<NativeDiagnostics>('MobileDiagnostics');
