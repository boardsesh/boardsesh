import type { MobileStorePlatform } from '@boardsesh/shared-schema/mobile-store-release';
import { readMobileStoreRelease } from '../../services/mobile-store-release';

export const mobileStoreReleaseQueries = {
  // Public metadata: signing in must never be required to learn about updates.
  mobileStoreRelease: (_parent: unknown, args: { platform: MobileStorePlatform; nativeVersion: string }) =>
    readMobileStoreRelease(args.platform, args.nativeVersion),
};
