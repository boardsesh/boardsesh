import { useCallback, useMemo } from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import { reportError } from '../lib/error-reporting';
import { hapticError, hapticLight } from '../lib/haptics';
import {
  isSentryEnabled,
  nativeSentryCrash,
  nativeAbortSentryCrash,
  canNativeAbortSentryCrash,
  setSentryDiagnosticTestContext,
} from '../lib/sentry';
import { scheduleUncaughtSentryTestError, beginSentryDiagnosticTest } from '../lib/sentry-diagnostics';
import { useProfile } from '../lib/graphql/hooks';
import { useConfirm } from '../providers/dialog-provider';
import { useTheme } from '../providers/theme-provider';
import { SwitcherForm } from './SwitcherForm';
import type { SwitcherFormModel } from './SwitcherForm.types';

/** Tester-only controls for verifying each Sentry capture path on a real build. */
export function SentryDiagnosticsScreen() {
  const { systemColors } = useTheme();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const confirm = useConfirm();

  const sendHandledEvent = useCallback(() => {
    hapticLight();
    const testRunId = beginSentryDiagnosticTest('handled');
    reportError(new Error('Sentry test event (handled) — diagnostics'), {
      tags: { source: 'sentry-test', kind: 'handled', testRunId },
    });
    Alert.alert(
      // i18n-ignore-next-line — tester-only screen
      'Test event sent',
      isSentryEnabled
        ? // i18n-ignore-next-line — tester-only screen
          'A handled event was sent to the Boardsesh Sentry project. Filter by source:sentry-test.'
        : // i18n-ignore-next-line — tester-only screen
          'Sentry is disabled in this build, so nothing was sent.',
    );
  }, []);

  const throwUncaughtError = useCallback(() => {
    hapticError();
    setSentryDiagnosticTestContext('uncaught-js', beginSentryDiagnosticTest('uncaught-js'));
    scheduleUncaughtSentryTestError();
  }, []);

  const triggerNativeCrash = useCallback(async () => {
    hapticLight();
    const confirmed = await confirm({
      // i18n-ignore-next-line — tester-only screen
      title: 'Force a native crash?',
      // i18n-ignore-next-line — tester-only screen
      message: 'The app crashes immediately. The crash uploads to Sentry on the next launch.',
      // i18n-ignore-next-line — tester-only screen
      confirmLabel: 'Crash',
      // i18n-ignore-next-line — tester-only screen
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    hapticError();
    setSentryDiagnosticTestContext('java-exception', beginSentryDiagnosticTest('java-exception'));
    nativeSentryCrash();
  }, [confirm]);

  const triggerNativeAbort = useCallback(async () => {
    const confirmed = await confirm({
      // i18n-ignore-next-line — tester-only screen
      title: 'Force a C/C++ abort?',
      // i18n-ignore-next-line — tester-only screen
      message: 'The app crashes immediately. Reopen it to upload the native backtrace and tombstone.',
      // i18n-ignore-next-line — tester-only screen
      confirmLabel: 'Crash',
      // i18n-ignore-next-line — tester-only screen
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    if (!canNativeAbortSentryCrash()) {
      // i18n-ignore-next-line — tester-only screen
      Alert.alert('Native abort unavailable', 'Install a release binary with native diagnostics and Sentry enabled.');
      return;
    }
    setSentryDiagnosticTestContext('native-abort', beginSentryDiagnosticTest('native-abort'));
    nativeAbortSentryCrash();
  }, [confirm]);

  const model = useMemo<SwitcherFormModel>(
    () => ({
      sections: [
        {
          key: 'sentry',
          // i18n-ignore-next-line — tester-only screen
          title: 'Test crash reporting (Sentry)',
          rows: [
            {
              kind: 'info',
              key: 'status',
              // i18n-ignore-next-line — tester-only screen
              label: 'Sentry',
              // i18n-ignore-next-line — tester-only screen
              value: isSentryEnabled ? 'Active' : 'Disabled in this build',
            },
            {
              kind: 'action',
              key: 'handled',
              // i18n-ignore-next-line — tester-only screen
              label: 'Send test event (handled)',
              icon: 'send',
              onPress: sendHandledEvent,
            },
            {
              kind: 'action',
              key: 'uncaught',
              // i18n-ignore-next-line — tester-only screen
              label: 'Throw JS exception (uncaught)',
              icon: 'warning',
              onPress: throwUncaughtError,
            },
            {
              kind: 'action',
              key: 'native',
              // i18n-ignore-next-line — tester-only screen
              label: 'Java / Objective-C exception',
              icon: 'flame',
              onPress: () => void triggerNativeCrash(),
            },
            {
              kind: 'action',
              key: 'native-abort',
              // i18n-ignore-next-line — tester-only screen
              label: 'C/C++ abort (SIGABRT)',
              icon: 'flame',
              onPress: () => void triggerNativeAbort(),
            },
          ],
        },
      ],
    }),
    [sendHandledEvent, throwUncaughtError, triggerNativeCrash, triggerNativeAbort],
  );

  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
          <ActivityIndicator />
        </View>
      );
    }
    if (!profile?.isTester) {
      return <Redirect href="/settings" />;
    }
  }

  return <SwitcherForm model={model} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
