import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import type { FirstBoardGymState } from '../../lib/boards/first-board-gym-state';
import { spacing } from '../../theme/tokens';

type NearbySearchStatusProps = {
  /** Where the search for boards near the climber stands; see `firstBoardGymState`. */
  state: FirstBoardGymState;
  onFindGymOnMap: () => void;
  onOpenSettings: () => void;
  /** Asks for the boards near the climber again, after `nearby_error`. */
  onRetryNearby: () => void;
};

/**
 * What a search for boards near the climber says when it has no list to show
 * (#5654): still looking, nothing within 20 km, the lookup failed, or location
 * is off. Each one says what happened and offers the next step: the gym map,
 * a retry, or Settings. Nothing here only looks tappable.
 *
 * Shared by the first-board picker's "At a gym" choice and the ordinary
 * picker's Find nearby tile, which used to go dim and dead on a denial and
 * silently back to idle on an empty result. Renders nothing for `idle` and
 * `found`: the caller owns the list.
 */
export function NearbySearchStatus({ state, onFindGymOnMap, onOpenSettings, onRetryNearby }: NearbySearchStatusProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const mapButton = <Button title={t('mobile.firstBoard.findGymOnMap')} variant="text" onPress={onFindGymOnMap} />;

  switch (state) {
    case 'searching':
      return (
        <View style={styles.panel} accessibilityLiveRegion="polite">
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.firstBoard.searching')}
          </Text>
        </View>
      );
    case 'none_nearby':
      return (
        <View style={styles.panel} accessibilityLiveRegion="polite">
          <Text variant="subheadline">{t('mobile.firstBoard.nearbyEmpty')}</Text>
          {mapButton}
        </View>
      );
    case 'nearby_error':
      return (
        <View style={styles.panel} accessibilityLiveRegion="polite">
          <Text variant="subheadline">{t('mobile.firstBoard.nearbyError')}</Text>
          <View style={styles.actions}>
            <Button title={t('mobile.errorRetry')} variant="tonal" size="small" onPress={onRetryNearby} />
            {mapButton}
          </View>
        </View>
      );
    case 'location_off':
      return (
        <View style={styles.panel} accessibilityLiveRegion="polite">
          <Text variant="subheadline">{t('mobile.firstBoard.locationOff')}</Text>
          <View style={styles.actions}>
            {canOpenAppSettings() ? (
              <Button
                title={t('mobile.firstBoard.openSettings')}
                variant="tonal"
                size="small"
                onPress={onOpenSettings}
              />
            ) : null}
            {mapButton}
          </View>
        </View>
      );
    case 'idle':
    case 'found':
      return null;
  }
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
    alignItems: 'flex-start',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
});
