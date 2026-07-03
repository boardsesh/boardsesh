import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeInstallReferrerResult = {
  installReferrer: string;
  referrerClickTimestampSeconds: number;
  installBeginTimestampSeconds: number;
};

type InstallReferrerNativeModule = {
  getInstallReferrer(): Promise<NativeInstallReferrerResult | null>;
};

// requireOptionalNativeModule returns null (silently) when the module isn't
// linked into the running binary — iOS (this module is Android-only), Expo
// Go, or a dev client built before this module existed — so callers never
// need a platform/linked check before calling.
export const installReferrerNative = requireOptionalNativeModule<InstallReferrerNativeModule>('InstallReferrer');
