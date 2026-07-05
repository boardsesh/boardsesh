import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { remainingSeconds, requestWatchPairingCode, type WatchPairingCode } from '../../lib/watch-pairing';

/**
 * "Pair a Garmin watch" — request a short code from the backend, show it big and
 * monospaced with a live countdown, and offer a fresh one once it lapses. The
 * climber starts the Boardsesh activity on their Garmin, then types the code to
 * link the watch to their account. The pairing code fetch carries the user's
 * bearer via `authenticatedFetch`.
 */
export function WatchPairScreen() {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();

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

  const hasActiveCode = pairing !== null && secondsLeft > 0;
  const isExpired = pairing !== null && secondsLeft <= 0;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {t('watchPairing.description')}
        </Text>
      </View>

      <View style={[styles.card, styles.codeCard, { backgroundColor: systemColors.secondaryBackground }]}>
        {isLoading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={brandColors.primary} />
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('watchPairing.generating')}
            </Text>
          </View>
        ) : hasActiveCode ? (
          <>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centeredText}>
              {t('watchPairing.codeInstruction')}
            </Text>
            <Text
              accessibilityLabel={pairing.code}
              color={systemColors.label}
              style={[styles.codeText, { color: systemColors.label }]}
            >
              {pairing.code}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredText}>
              {t('watchPairing.expiresIn', { seconds: secondsLeft })}
            </Text>
            <Button title={t('watchPairing.regenerate')} variant="text" onPress={generate} disabled={isLoading} />
          </>
        ) : isExpired ? (
          <>
            <Text variant="body" color={systemColors.label} style={styles.centeredText}>
              {t('watchPairing.expired')}
            </Text>
            <Button
              title={t('watchPairing.regenerate')}
              variant="filled"
              onPress={generate}
              disabled={isLoading}
              loading={isLoading}
            />
          </>
        ) : (
          <Button
            title={t('watchPairing.generate')}
            variant="filled"
            onPress={generate}
            disabled={isLoading}
            loading={isLoading}
          />
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[5],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    padding: spacing[4],
  },
  codeCard: {
    alignItems: 'center',
    gap: spacing[3],
  },
  loadingBlock: {
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  centeredText: {
    textAlign: 'center',
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 44,
    lineHeight: 52,
    fontWeight: '700',
    letterSpacing: 8,
    textAlign: 'center',
  },
});
