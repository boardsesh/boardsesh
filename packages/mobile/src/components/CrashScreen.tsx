import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View, useColorScheme, type ColorSchemeName } from 'react-native';
import { router } from 'expo-router';
import * as Updates from 'expo-updates';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { brandColors, brandColorsDark, materialSurfaces } from '../theme/colors';
import { spacing } from '../theme/tokens';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { track, getAnalyticsClient } from '../lib/analytics';
import { performOtaRecovery, type OtaRecoveryPhase } from '../lib/ota-recovery';
import { runOtaOperation } from '../lib/ota-operation-owner';
import {
  captureOtaReloadReceipt,
  fetchOwnedOtaUpdate,
  isOtaReloadReceiptCurrent,
  waitForOtaUpdatesIdle,
  waitForOtaReloadReceipt,
} from '../lib/qa/qa-surf';
import { reportScreenshotSmokeError } from '../lib/screenshot-smoke';

const errorStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing[6],
  },
  iconContainer: {
    marginBottom: spacing[5],
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  message: {
    textAlign: 'center',
    marginBottom: spacing[8],
  },
  // Only the fallback (no explicit palette) dims; an explicit secondaryLabel is
  // already the muted tone and dimming it again drops it under 4.5:1.
  dimmed: {
    opacity: 0.7,
  },
  buttonRow: {
    gap: spacing[3],
    width: '100%',
    maxWidth: 280,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: 12,
    paddingHorizontal: spacing[5],
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: spacing[5],
  },
  pressedButton: {
    opacity: 0.72,
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonLabel: {
    fontWeight: '700',
  },
  statusText: {
    textAlign: 'center',
    marginTop: spacing[4],
    maxWidth: 280,
  },
});

export type ErrorBoundaryProps = {
  error: Error;
  retry: () => void;
};

// Recovery-button UI state. `busy` carries the live phase so the button label
// doubles as a status line; the two terminal non-reload results each surface a
// short message under the buttons (the reload results restart the app, so they
// never render a follow-up state here).
type RecoveryState =
  | { kind: 'idle' }
  | { kind: 'busy'; phase: OtaRecoveryPhase }
  | { kind: 'no-fix-available' }
  | { kind: 'failed' };

type CrashScreenPalette = {
  background: string | undefined;
  label: string | undefined;
  secondaryLabel: string | undefined;
  brand: typeof brandColors | typeof brandColorsDark;
};

// This screen renders above every provider, so Text has no theme colour to fall
// back on and paints black. The web shell and the native dark root are both
// black, so those take the dark Velvet surface explicitly. Native light keeps
// the system default (black on the light root).
export function resolveCrashScreenPalette(os: typeof Platform.OS, scheme: ColorSchemeName): CrashScreenPalette {
  if (os === 'web' || scheme === 'dark') {
    const surface = materialSurfaces.dark;
    return {
      background: surface.background,
      label: surface.label,
      secondaryLabel: surface.secondaryLabel,
      brand: brandColorsDark,
    };
  }
  return { background: undefined, label: undefined, secondaryLabel: undefined, brand: brandColors };
}

export function CrashScreen({ error, retry }: ErrorBoundaryProps) {
  // No useTranslation here: Expo Router renders this before any of our
  // providers mount, so i18next isn't initialized. Calling the hook would
  // return raw key strings exactly when the user most needs readable copy.
  // Hardcode English as the last-resort safe fallback.
  const palette = resolveCrashScreenPalette(Platform.OS, useColorScheme());
  const reportedRef = useRef<Error | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: 'idle' });

  // The check/fetch/reload calls throw ERR_UPDATES_DISABLED in dev, so only offer
  // recovery on a real store/TestFlight binary that ships with updates enabled.
  const showRecoveryButton = Updates.isEnabled && !__DEV__;
  const isBusy = recovery.kind === 'busy';

  useEffect(() => {
    if (reportedRef.current !== error) {
      reportedRef.current = error;
      reportError(error);
      // The E2E gate's smoke fails on this ping (docs/mobile-e2e-gate.md): iOS
      // Maestro cannot see this screen, so the screen says it mounted. Inlined
      // so a normal build strips it.
      if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') reportScreenshotSmokeError(error);
      // Module-level track() works without AnalyticsProvider (it drives the same
      // lazily-built PostHog client), so the crash screen is observable. Tag the
      // OTA cohort so a broken-bundle spike is sliceable by update id / channel.
      track('Error Screen Shown', {
        ota_update_id: Updates.updateId,
        ota_is_embedded: Updates.isEmbeddedLaunch,
        ota_channel: Updates.channel,
      });
    }
  }, [error]);

  const handleGoHome = () => {
    router.replace('/(tabs)/home');
  };

  const handleCheckForFix = useCallback(async () => {
    setRecovery({ kind: 'busy', phase: 'checking' });
    const { result, error: recoveryError } = await performOtaRecovery(
      {
        runOperation: runOtaOperation,
        waitForIdle: waitForOtaUpdatesIdle,
        checkForUpdate: () => Updates.checkForUpdateAsync(),
        fetchUpdate: fetchOwnedOtaUpdate,
        reload: () => Updates.reloadAsync(),
        captureReloadReceipt: captureOtaReloadReceipt,
        waitForReloadReceipt: waitForOtaReloadReceipt,
        isReloadReceiptCurrent: isOtaReloadReceiptCurrent,
      },
      {
        onPhase: (phase) => setRecovery({ kind: 'busy', phase }),
        // Track the reloaded-* outcomes BEFORE the reload — a post-return track()
        // would race the app restart and typically be lost. track() only enqueues,
        // so flush best-effort (fire-and-forget; the reload follows immediately, we
        // don't delay it — delivery is best-effort) to give it a window.
        onBeforeReload: (result) => {
          track('OTA Recovery Attempted', { result });
          void getAnalyticsClient()?.flush();
        },
      },
    );
    // The reloaded-* outcomes are tracked in onBeforeReload above (before the
    // restart). Only these non-reload terminal results reliably reach here, so
    // guard the post-return track to avoid double-counting a reloaded-* result if
    // JS happens to survive the reload.
    if (result === 'failed' || result === 'no-fix-available') {
      track('OTA Recovery Attempted', { result });
    }
    if (result === 'failed') {
      reportHandledError(recoveryError, { tags: { source: 'ota-error-screen' } });
      setRecovery({ kind: 'failed' });
    } else if (result === 'no-fix-available') {
      setRecovery({ kind: 'no-fix-available' });
    }
    // A reloaded-* result means the app is restarting — leave the busy state be.
  }, []);

  const primaryButtonStyle = [errorStyles.primaryButton, { backgroundColor: palette.brand.primaryFill }];
  const secondaryButtonStyle = [errorStyles.secondaryButton, { borderColor: palette.brand.primary }];

  const recoveryLabel =
    recovery.kind === 'busy' ? (recovery.phase === 'downloading' ? 'Downloading…' : 'Checking…') : 'Check for a fix';

  return (
    <View style={[errorStyles.container, palette.background ? { backgroundColor: palette.background } : null]}>
      <View style={errorStyles.iconContainer}>
        {/* Palette comes from the OS colour scheme on purpose: this boundary can
            render outside the ThemeProvider, where useTheme() would throw. */}
        <Icon name="warning" size={48} color={palette.brand.warning} />
      </View>
      <Text variant="title2" color={palette.label} style={errorStyles.title}>
        Something went wrong
      </Text>
      <Text
        variant="body"
        color={palette.secondaryLabel}
        style={[errorStyles.message, !palette.secondaryLabel && errorStyles.dimmed]}
      >
        The app hit an unexpected error. You can try again or head back home.
      </Text>
      <View style={errorStyles.buttonRow}>
        {/* On a real binary, offer the one-tap OTA recovery first: check for a
            newer bundle (or a published rollback directive), download it, and
            reload onto it. It takes the primary slot; "Try again" demotes to the
            secondary style. In dev / when the button is hidden, "Try again" keeps
            the primary style. */}
        {showRecoveryButton && (
          <PressableSurface
            onPress={() => void handleCheckForFix()}
            disabled={isBusy}
            accessibilityRole="button"
            accessibilityLabel="Check for a fix"
            accessibilityState={{ disabled: isBusy, busy: isBusy }}
            style={({ pressed }) => [
              errorStyles.primaryButton,
              { backgroundColor: palette.brand.primaryFill },
              pressed && errorStyles.pressedButton,
              isBusy && errorStyles.disabledButton,
            ]}
          >
            <Text variant="body" color={palette.brand.onPrimary} style={errorStyles.buttonLabel}>
              {recoveryLabel}
            </Text>
          </PressableSurface>
        )}
        <PressableSurface
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={({ pressed }) => [
            showRecoveryButton ? secondaryButtonStyle : primaryButtonStyle,
            pressed && errorStyles.pressedButton,
          ]}
        >
          <Text
            variant="body"
            color={showRecoveryButton ? palette.brand.primary : palette.brand.onPrimary}
            style={errorStyles.buttonLabel}
          >
            Try again
          </Text>
        </PressableSurface>
        <PressableSurface
          onPress={handleGoHome}
          accessibilityRole="button"
          accessibilityLabel="Go home"
          style={({ pressed }) => [secondaryButtonStyle, pressed && errorStyles.pressedButton]}
        >
          <Text variant="body" color={palette.brand.primary} style={errorStyles.buttonLabel}>
            Go home
          </Text>
        </PressableSurface>
      </View>
      {recovery.kind === 'no-fix-available' && (
        <Text
          variant="footnote"
          color={palette.secondaryLabel}
          style={[errorStyles.statusText, !palette.secondaryLabel && errorStyles.dimmed]}
        >
          No fix available yet — try again in a few minutes.
        </Text>
      )}
      {recovery.kind === 'failed' && (
        <Text
          variant="footnote"
          color={palette.secondaryLabel}
          style={[errorStyles.statusText, !palette.secondaryLabel && errorStyles.dimmed]}
        >
          Couldn&apos;t reach the update server. Check your connection and try again.
        </Text>
      )}
    </View>
  );
}
