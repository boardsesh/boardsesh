import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { TextAction } from '../TextAction';
import { ActivityIndicator } from '../ActivityIndicator';
import { LocationAskCard } from '../location/LocationAskCard';
import { useTheme } from '../../providers/theme-provider';
import { shouldOfferLocationAsk, useLocationAskSnoozed } from '../../lib/location-ask';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { spacing } from '../../theme/tokens';
import type { LocationPermission, LocationRequest, LocationStatus } from '../../lib/use-device-location';

export type GymLocationPromptProps = {
  status: LocationStatus;
  permission: LocationPermission;
  /** The on-open permission read is back (`useDeviceLocation().permissionChecked`). */
  permissionChecked: boolean;
  /** Shows the system prompt (or retries a failed fix): the location hook's `request`. */
  onRequest: LocationRequest;
  /** Reads the permission again without asking: the location hook's `requestIfAllowed`. */
  onRecheck: () => Promise<LocationPermission>;
};

/**
 * The gym panel's body while there's no place to centre the map on yet. The
 * screen never asks for location on open (it only reads an earlier yes), so:
 *  - before that read is back: a spinner.
 *  - location off: "See gyms near you" (`LocationAskCard`), the same card and
 *    the same 14-day "Not now" as the board picker. It stays mounted while
 *    its own Allow is asking, so it reports itself shown once per visit.
 *  - a fix on its way: a spinner.
 *  - a fix that failed with location allowed (Location Services off for the
 *    whole phone, a GPS error): the line and Use my location, which tries again.
 *  - after a "Not now" (or with no location module to read): one line pointing
 *    at the search box above, and a quiet Use my location. The climber opened
 *    the map on purpose, so a tap there is their own request, not a nag: it
 *    asks (or opens Settings once only Settings can) whatever the snooze says.
 *    Where nothing can open Settings (a browser) and the answer was no, it
 *    would be a dead tap, so it is left out.
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

  if (!permissionChecked) {
    return <ActivityIndicator size="large" />;
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

  if (status === 'loading') {
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

  const settingsOnly = permission === 'blocked';
  const onUseMyLocation = () => {
    if (settingsOnly) void openAppSettings();
    else void onRequest();
  };

  return (
    <>
      <Icon name="search" size={40} color={systemColors.tertiaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
        {t('mobile.locationAsk.searchHint')}
      </Text>
      {settingsOnly && !canOpenAppSettings() ? null : (
        <TextAction label={t('mobile.gyms.grantLocation')} onPress={onUseMyLocation} testID="gym-use-my-location" />
      )}
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
