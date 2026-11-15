import { useEffect, useState, type ReactNode } from 'react';
import { LogBox, Text, View } from 'react-native';
import { SplashScreen } from 'expo-router';
import {
  ONBOARDING_TIP_WORKOUT_KEY,
  ONBOARDING_TIP_CREW_KEY,
  ONBOARDING_TIP_RECORD_KEY,
  ONBOARDING_TIP_ACCESSORY_KEY,
  ONBOARDING_TIP_PREVIEW_FIRST_KEY,
  ONBOARDING_TIP_QUICKACTIONS_KEY,
} from '@boardsesh/key-value-storage';
import { resolveAuthSession } from '../../lib/auth-session';
import { signInWithCredentials } from '../../lib/auth';
import { setSetting } from '../../settings';
import { markOnboardingSeen, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { updateConsentState } from '../../lib/consent-state';
import { reportScreenshotSmokeError } from './screenshot-smoke';
import { prepareRecordingTransport } from './recording-transport';
import { prepareIntegrationSession } from './prepare-session';

let preparation: Promise<void> | undefined;
function prepare(): Promise<void> {
  prepareRecordingTransport();
  LogBox.ignoreAllLogs(true);
  preparation ??= prepareIntegrationSession({
    resolveSession: resolveAuthSession,
    signIn: async () => {
      const email = process.env.EXPO_PUBLIC_SCREENSHOT_USER_EMAIL;
      const password = process.env.EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD;
      if (!email || !password) throw new Error('Integration credentials are missing');
      return signInWithCredentials(email, password);
    },
    preparePreferences: async () => {
      // These are preferences on the isolated test device, never view fixtures.
      updateConsentState({ killed: true, loaded: true, settled: true });
      setSetting('startupScreen', 'home');
      setSetting('qaPromptOnLaunch', false);
      await markOnboardingSeen();
      await Promise.all(
        [
          ONBOARDING_TIP_WORKOUT_KEY,
          ONBOARDING_TIP_CREW_KEY,
          ONBOARDING_TIP_RECORD_KEY,
          ONBOARDING_TIP_ACCESSORY_KEY,
          ONBOARDING_TIP_PREVIEW_FIRST_KEY,
          ONBOARDING_TIP_QUICKACTIONS_KEY,
        ].map(markTipSeen),
      );
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  return preparation;
}

export function IntegrationBootstrap({ renderApplication }: { renderApplication: () => ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    void prepare().then(
      () => {
        if (!cancelled) setReady(true);
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        reportScreenshotSmokeError(error);
        if (!cancelled) setFailure(error);
        void SplashScreen.hideAsync();
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (failure)
    return (
      <View>
        <Text accessibilityRole="alert">{failure.message}</Text>
      </View>
    );
  return ready ? renderApplication() : null;
}
