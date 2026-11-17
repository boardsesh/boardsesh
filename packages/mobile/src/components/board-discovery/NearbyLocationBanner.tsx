import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import { spacing } from '../../theme/tokens';
import { Button } from '../Button';
import { Card } from '../Card';
import { Text } from '../Text';

type NearbyLocationBannerProps = {
  /** How location can be turned on: the permission prompt (`ask`), or only Settings (`blocked`). */
  permission: 'ask' | 'blocked';
  /** Asks for location: the system prompt. */
  onAllowLocation: () => void;
  onOpenSettings: () => void;
};

/**
 * The foot of the board picker while location is off. Near you has nothing to
 * show without it, so it gives way to one line saying what turning location on
 * gets the climber, and the one way to do it: Allow location while the prompt
 * can still ask, Open Settings once only Settings can. Where Settings can't be
 * opened (a browser), the line stands alone. The button is the only thing to
 * tap, so the line is never accent coloured.
 */
export function NearbyLocationBanner({ permission, onAllowLocation, onOpenSettings }: NearbyLocationBannerProps) {
  const { t } = useTranslation('boards');
  let action: ReactElement | null = null;
  if (permission === 'ask') {
    action = (
      <Button
        title={t('mobile.discovery.allowLocation')}
        size="small"
        variant="tonal"
        icon="location"
        onPress={onAllowLocation}
      />
    );
  } else if (canOpenAppSettings()) {
    action = (
      <Button title={t('mobile.firstBoard.openSettings')} size="small" variant="tonal" onPress={onOpenSettings} />
    );
  }
  return (
    <View style={styles.gutter} testID="picker-location-banner">
      <Card>
        <View style={styles.stack}>
          <Text variant="subheadline">{t('mobile.discovery.locationBanner')}</Text>
          {action ? <View style={styles.buttonRow}>{action}</View> : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: spacing[4],
  },
  stack: {
    gap: spacing[3],
  },
  buttonRow: {
    flexDirection: 'row',
  },
});
