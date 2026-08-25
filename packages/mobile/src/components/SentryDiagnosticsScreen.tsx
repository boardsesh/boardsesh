import { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';
import { reportError } from '../lib/error-reporting';
import { hapticError, hapticLight } from '../lib/haptics';
import { isSentryEnabled, nativeSentryCrash } from '../lib/sentry';
import { useProfile } from '../lib/graphql/hooks';
import { useConfirm } from '../providers/dialog-provider';
import { SwitcherForm } from './SwitcherForm';
import type { SwitcherFormModel } from './SwitcherForm.types';

/** Tester-only controls for verifying each Sentry capture path on a real build. */
export function SentryDiagnosticsScreen() {
  const { data: profile } = useProfile();
  const confirm = useConfirm();

  const sendHandledEvent = useCallback(() => {
    hapticLight();
    reportError(new Error('Sentry test event (handled) — diagnostics'), {
      tags: { source: 'sentry-test', kind: 'handled' },
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
    setTimeout(() => {
      throw new Error('Sentry test: uncaught JS exception — diagnostics');
    }, 0);
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
    nativeSentryCrash();
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
              label: 'Native crash',
              icon: 'flame',
              onPress: () => void triggerNativeCrash(),
            },
          ],
        },
      ],
    }),
    [sendHandledEvent, throwUncaughtError, triggerNativeCrash],
  );

  if (!profile?.isTester) return null;
  return <SwitcherForm model={model} />;
}
