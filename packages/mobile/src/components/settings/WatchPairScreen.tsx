import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { MoreForm } from '../MoreForm';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { withSettingTracking } from '../../lib/settings-analytics';
import { remainingSeconds, requestWatchPairingCode, type WatchPairingCode } from '../../lib/watch-pairing';
import { WATCH_PAIR_CODE_TEXT_FIT, buildWatchPairModel, watchPairCodeHeight } from './watch-pair-model';

/**
 * "Pair a Garmin watch" — request a short code from the backend, show it big and
 * monospaced with a live countdown, and offer a fresh one once it lapses. The
 * climber starts the Boardsesh activity on their Garmin, then types the code to
 * link the watch to their account. The pairing code fetch carries the user's
 * bearer via `authenticatedFetch`.
 */
export function WatchPairScreen() {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('settings');
  const { systemColors, textStyles } = useTheme();
  const { showToast } = useToast();
  // The code row is pinned in points by the native form before React Native lays
  // it out, so its height follows the climber's text size.
  const { fontScale } = useWindowDimensions();

  const [pairing, setPairing] = useState<WatchPairingCode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Seconds left on the current code, ticked once a second by the effect below.
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Derive the countdown from `expiresAt` on a 1s interval rather than trusting a
  // decrement (which drifts if a tick is dropped while backgrounded). Cleared on
  // unmount and whenever a new code replaces the old one; stops ticking at 0.
  useEffect(() => {
    if (!pairing) return;
    setSecondsLeft(remainingSeconds(pairing.expiresAt));
    const interval = setInterval(() => {
      const next = remainingSeconds(pairing.expiresAt);
      setSecondsLeft(next);
      if (next <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [pairing]);

  const generate = useCallback(() => {
    setIsLoading(true);
    void (async () => {
      try {
        const result = await requestWatchPairingCode();
        setPairing(result);
        // Seed synchronously so the first paint shows the real countdown instead
        // of flashing the stale "expired" state before the effect runs.
        setSecondsLeft(remainingSeconds(result.expiresAt));
      } catch {
        // A failed code request is routine (offline, transient 5xx) — surface a
        // toast so the user can retry; don't report it as an error.
        showToast(t('watchPairing.error'), 'error');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [showToast, t]);

  const code = pairing?.code ?? null;
  const { largeTitle } = textStyles;
  const codeHeight = watchPairCodeHeight(
    fontScale,
    largeTitle.lineHeight ?? Math.ceil((largeTitle.fontSize ?? 34) * 1.2),
  );
  const codeView = useMemo(
    () =>
      code ? (
        <View style={[styles.codeRow, { height: codeHeight }]}>
          <Text
            accessibilityLabel={code}
            {...WATCH_PAIR_CODE_TEXT_FIT}
            style={[styles.codeText, { color: systemColors.label }]}
          >
            {code}
          </Text>
        </View>
      ) : null,
    [code, codeHeight, styles, systemColors.label],
  );

  const model = useMemo(
    () =>
      withSettingTracking(
        buildWatchPairModel({
          t,
          isLoading,
          code,
          secondsLeft,
          codeView,
          codeHeight,
          onGenerate: generate,
        }),
        'watch-pair',
      ),
    [t, isLoading, code, secondsLeft, codeView, codeHeight, generate],
  );

  return <MoreForm model={model} />;
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    codeRow: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    codeText: {
      fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
      fontSize: textStyles.largeTitle.fontSize,
      lineHeight: textStyles.largeTitle.lineHeight,
      fontWeight: '700',
      letterSpacing: 8,
      textAlign: 'center',
    },
  });
