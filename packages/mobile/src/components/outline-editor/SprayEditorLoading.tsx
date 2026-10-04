import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayScanPhoto } from '../spray-wall/SprayScanPhoto';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/** The wall's photo as the phone holds it: a local file and its pixel size. */
export type SprayEditorLoadingPhoto = { uri: string; width: number; height: number };

type SprayEditorLoadingProps = {
  /** The local photo, when the add-a-wall flow still has it. Null everywhere else. */
  photo: SprayEditorLoadingPhoto | null;
  /** The draft's read failed or is parked offline: say so and offer `onRetry`. */
  stalled: boolean;
  onRetry: () => void;
};

/**
 * What the hold editor shows until its draft has loaded. Never a bare spinner:
 * the wait always says what it is, and a read that is not running says that
 * instead and offers a retry.
 *
 * With the photo still on the phone it sits where the scan left it, dimmed,
 * with no scan band (the scan is over). Without one it is a spinner and a line.
 */
export function SprayEditorLoading({ photo, stalled, onRetry }: SprayEditorLoadingProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const message = stalled ? t('sprayEditor.loadStalled') : t('sprayEditor.loading');
  const retryLabel = t('sprayDetection.retry');
  const retry = useMemo(() => ({ label: retryLabel, onPress: onRetry }), [retryLabel, onRetry]);

  // `accessibilityLiveRegion` only speaks on Android. Said once each time the
  // wait turns into a stall, not on every render.
  const stalledMessage = stalled ? message : null;
  useEffect(() => {
    if (stalledMessage) AccessibilityInfo.announceForAccessibility(stalledMessage);
  }, [stalledMessage]);

  if (photo) {
    return <SprayScanPhoto photo={photo} message={message} failed={stalled} retry={retry} band={false} />;
  }

  return (
    <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
      {stalled ? null : <ActivityIndicator size="large" />}
      <Text
        variant="subheadline"
        color={systemColors.secondaryLabel}
        style={styles.message}
        accessibilityLiveRegion="polite"
      >
        {message}
      </Text>
      {stalled ? <Button title={retryLabel} variant="filled" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
    gap: spacing[3],
  },
  message: {
    textAlign: 'center',
  },
});
