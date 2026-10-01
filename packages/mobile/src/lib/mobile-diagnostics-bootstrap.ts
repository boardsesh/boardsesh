// Side effects belong here, never in the recorder imported by pure tests.
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { clientID } from 'expo-eas-client';
import * as Updates from 'expo-updates';
import * as Sentry from '@sentry/react-native';
import { nativeMobileDiagnostics } from '../../modules/mobile-diagnostics/src';
import { bootstrapDiagnosticLaunch, canAttributePreviousNativeCrash } from './diagnostic-launch';
import { SECURE_STORE_V2_OPTIONS } from './secure-store-options';
import { readOtaBranch } from './ota-telemetry';
import { beginDiagnosticOperation, initializeMobileDiagnostics, updateDiagnosticLaunch } from './mobile-diagnostics';

const LAUNCH_KEY = 'boardsesh_diagnostic_launch_v1';
let previousSerialized: string | null = null;
initializeMobileDiagnostics(
  bootstrapDiagnosticLaunch({
    makeId: randomUUID,
    readPrevious: () => {
      previousSerialized = SecureStore.getItem(LAUNCH_KEY, SECURE_STORE_V2_OPTIONS);
      return previousSerialized;
    },
    writeCurrent: (serialized) => SecureStore.setItem(LAUNCH_KEY, serialized, SECURE_STORE_V2_OPTIONS),
    metadata: {
      nativeStartupId: nativeMobileDiagnostics?.nativeStartupId ?? null,
      easClientId: clientID,
      otaUpdateId: Updates.updateId,
      otaBranch: readOtaBranch(Updates.manifest),
      otaRuntimeVersion: Updates.runtimeVersion,
      otaIsEmbedded: Updates.isEmbeddedLaunch,
    },
  }),
);

// Query only the SDK's confirmed result. An unclean launch or ordinary OTA
// reload is not evidence that the preceding process crashed.
if (
  !__DEV__ &&
  process.env.EXPO_PUBLIC_SENTRY_DSN &&
  canAttributePreviousNativeCrash(
    previousSerialized,
    nativeMobileDiagnostics?.nativeStartupId,
    nativeMobileDiagnostics?.previousNativeStartupId,
  )
) {
  void Sentry.crashedLastRun()
    .then((crashed) => {
      if (typeof crashed === 'boolean') updateDiagnosticLaunch({ previousLaunchCrashed: crashed });
    })
    .catch(() => {});
}

const startup = beginDiagnosticOperation('navigation', 'startup');
startup.step('runtime_ready', { appState: AppState.currentState });
startup.finish('success');
AppState.addEventListener('change', (appState) => {
  const transition = beginDiagnosticOperation('navigation', 'lifecycle', { attributes: { appState } });
  transition.finish('success');
});
