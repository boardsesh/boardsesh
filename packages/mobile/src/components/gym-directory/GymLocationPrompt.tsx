import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { spacing } from '../../theme/tokens';
import type { LocationStatus } from '../../lib/use-device-location';

export type GymLocationPromptProps = {
  status: LocationStatus;
  /** Kick off (or retry) the permission prompt + one-shot fix. */
  onRequest: () => void;
};

/**
 * Prompt shown in the gym-panel body while there's no location to center the
 * map on yet. Three states:
 *  - idle/loading: a spinner while the one-shot request is in flight.
 *  - denied, and this platform can't deep-link to OS settings (Expo web —
 *    the browser's permission prompt won't come back and there's no settings
 *    link to send the user to): explanatory copy only, no button. The header
 *    search field above this panel is the working path on web, which is what
 *    the copy tells the user to use instead.
 *  - anything else (idle/loading fallthrough already handled above, so in
 *    practice: denied on native, or unavailable): the icon + copy + a button
 *    that either retries the request or, after a native denial, deep-links to
 *    Settings (iOS/Android only ever prompt once, so re-requesting after a
 *    denial would silently re-resolve denied).
 */
export function GymLocationPrompt({ status, onRequest }: GymLocationPromptProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  if (status === 'idle' || status === 'loading') {
    return <ActivityIndicator size="large" />;
  }

  if (status === 'denied' && !canOpenAppSettings()) {
    return (
      <>
        <Icon name="location" size={40} color={systemColors.tertiaryLabel} />
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
          {t('mobile.gyms.locationBlocked')}
        </Text>
      </>
    );
  }

  return (
    <>
      <Icon name="location" size={40} color={systemColors.tertiaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
        {t('mobile.gyms.locationNeeded')}
      </Text>
      <Button
        title={t('mobile.gyms.grantLocation')}
        variant="outlined"
        onPress={() => {
          if (status === 'denied') void openAppSettings();
          else onRequest();
        }}
        style={styles.centerButton}
      />
    </>
  );
}

const styles = StyleSheet.create({
  centerText: {
    textAlign: 'center',
  },
  centerButton: {
    marginTop: spacing[2],
  },
});
