import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { LocationAskCard } from '../location/LocationAskCard';
import { useTheme } from '../../providers/theme-provider';
import { shouldOfferLocationAsk, useLocationAskSnoozed } from '../../lib/location-ask';
import { spacing } from '../../theme/tokens';
import type { LocationPermission, LocationStatus } from '../../lib/use-device-location';

export type GymLocationPromptProps = {
  status: LocationStatus;
  permission: LocationPermission;
  /** The on-open permission read is back (`useDeviceLocation().permissionChecked`). */
  permissionChecked: boolean;
  /** Shows the system prompt (or retries a failed fix): the location hook's `request`. */
  onRequest: () => Promise<LocationPermission>;
  /** Reads the permission again without asking: the location hook's `requestIfAllowed`. */
  onRecheck: () => Promise<LocationPermission>;
};

/**
 * The gym panel's body while there's no place to centre the map on yet. The
 * screen never asks for location on open (it only reads an earlier yes), so:
 *  - before that read is back, or while a fix is on its way: a spinner.
 *  - a fix that failed with location allowed (Location Services off for the
 *    whole phone, a GPS error): the line and Use my location, which tries again.
 *  - location off: "See gyms near you" (`LocationAskCard`), the same card and
 *    the same 14-day "Not now" as the board picker.
 *  - after a "Not now" (or with no location module to read): one line pointing
 *    at the search box above, which works without location.
 */
export function GymLocationPrompt({
  status,
  permission,
  permissionChecked,
  onRequest,
  onRecheck,
}: GymLocationPromptProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const snoozed = useLocationAskSnoozed();

  if (!permissionChecked || status === 'loading') {
    return <ActivityIndicator size="large" />;
  }

  if (status === 'unavailable') {
    return (
      <>
        <Icon name="location" size={40} color={systemColors.tertiaryLabel} />
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
          {t('mobile.gyms.locationNeeded')}
        </Text>
        <Button
          title={t('mobile.gyms.grantLocation')}
          variant="outlined"
          onPress={() => void onRequest()}
          style={styles.centerButton}
        />
      </>
    );
  }

  if (shouldOfferLocationAsk(permission, snoozed)) {
    return (
      <LocationAskCard
        surface="gym_finder"
        permission={permission}
        onAllow={onRequest}
        onRecheck={onRecheck}
        style={styles.cardWidth}
      />
    );
  }

  return (
    <>
      <Icon name="search" size={40} color={systemColors.tertiaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
        {t('mobile.locationAsk.searchHint')}
      </Text>
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
  cardWidth: {
    alignSelf: 'stretch',
  },
});
