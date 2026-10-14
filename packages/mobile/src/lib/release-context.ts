import * as Updates from 'expo-updates';
import type { ReleaseContextInput } from '@boardsesh/shared-schema';
import { readOtaBranch } from './ota-telemetry';

/** The bundle executing now, independent of branch pins and pending downloads. */
export function readMobileReleaseContext(): Required<ReleaseContextInput> {
  if (!Updates.isEnabled) {
    return {
      channel: null,
      branch: null,
      updateId: null,
      runtimeVersion: null,
      isEmbeddedLaunch: null,
    };
  }
  return {
    channel: Updates.channel ?? null,
    branch: readOtaBranch(Updates.manifest),
    updateId: Updates.updateId ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  };
}
