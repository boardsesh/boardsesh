// What the connect-step test (#5654, PR 7) needs to know about the running
// build before it deals an arm. Kept apart from the enrolment so a test can
// stand in for the native reads.

import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { resolveAppEnvironment } from '../app-environment';
import { readOtaBranch } from '../ota-telemetry';
import { isPreviewBuild } from '../preview-build';

export type ConnectStepBuild = {
  /** The installed binary's version (`nativeApplicationVersion`), which no OTA can move. */
  nativeVersion: string | null;
  /**
   * A store or TestFlight binary running production JS. False for a dev build,
   * an EAS preview build and a `pr-*` OTA preview: whoever signs up there is
   * testing the app, not arriving at it.
   */
  productionBuild: boolean;
};

/** Pure half of `productionBuild`, so the rule is testable where `__DEV__` is always true. */
export function isConnectStepProductionBuild(input: {
  devBuild: boolean;
  /** An EAS preview binary (`preview-*` channel). */
  previewBuild: boolean;
  /** `resolveAppEnvironment()`: 'preview' inside a `pr-*` OTA bundle. */
  appEnvironment: string;
  /** xprem's running branch, or null on the production branch. */
  otaBranch: string | null;
}): boolean {
  if (input.devBuild || input.previewBuild) return false;
  if (input.appEnvironment !== 'production') return false;
  return input.otaBranch?.startsWith('pr-') !== true;
}

export function readConnectStepBuild(): ConnectStepBuild {
  return {
    nativeVersion: Application.nativeApplicationVersion,
    productionBuild: isConnectStepProductionBuild({
      devBuild: __DEV__,
      previewBuild: isPreviewBuild(),
      appEnvironment: resolveAppEnvironment(),
      otaBranch: readOtaBranch(Updates.manifest),
    }),
  };
}
