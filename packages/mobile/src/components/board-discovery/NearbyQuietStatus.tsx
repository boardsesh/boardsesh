import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import type { FirstBoardGymState } from '../../lib/boards/first-board-gym-state';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import { spacing } from '../../theme/tokens';
import { EmptyState } from '../EmptyState';
import { TextAction } from '../TextAction';
import { nearbyEmptyLine } from './nearby-board-type-copy';

type NearbyQuietStatusProps = {
  state: FirstBoardGymState;
  /** The search found boards, and every one of them is already shown above Near you. */
  allShownAbove: boolean;
  /** Asks for location (or searches again), before location was ever asked. */
  onSearchNearby: () => void;
  onRetryNearby: () => void;
  onOpenSettings: () => void;
  /** The gym map. Only offered here while the header's action is Show all, not Map. */
  onFindGymOnMap: () => void;
  boardType?: BoardName | null;
};

/**
 * The ordinary picker's Near you when it has no cards to show: one quiet
 * footnote line under the header, which already carries Map (or Show all when
 * narrowed to one type), with the one action that can change the answer. First
 * run keeps `NearbySearchStatus`'s fuller panel.
 *
 * Its action sits 8pt under the header's, and right under it once Map wraps
 * below the title at a large text size: it leans down, the header's leans up,
 * so their targets never overlap. Near you is the picker's last shelf, so
 * nothing below it is in reach.
 */
export function NearbyQuietStatus({
  state,
  allShownAbove,
  onSearchNearby,
  onRetryNearby,
  onOpenSettings,
  onFindGymOnMap,
  boardType = null,
}: NearbyQuietStatusProps) {
  const { t } = useTranslation('boards');
  if (allShownAbove) {
    return <EmptyState size="quiet" title={t('mobile.discovery.nearbyAllAbove')} />;
  }
  switch (state) {
    case 'idle':
      return (
        <View style={styles.quietAction}>
          <TextAction reach="down" label={t('mobile.discovery.showNearby')} onPress={onSearchNearby} />
        </View>
      );
    case 'searching':
      return (
        <View accessibilityLiveRegion="polite">
          <EmptyState size="quiet" title={t('mobile.firstBoard.searching')} />
        </View>
      );
    case 'none_nearby':
      // Narrowed, the header's action is Show all, so the map is offered here.
      return (
        <View accessibilityLiveRegion="polite">
          <EmptyState
            size="quiet"
            title={nearbyEmptyLine(t, boardType)}
            actions={
              boardType ? (
                <TextAction reach="down" label={t('mobile.discovery.nearbyMap')} onPress={onFindGymOnMap} />
              ) : undefined
            }
          />
        </View>
      );
    case 'nearby_error':
      return (
        <View accessibilityLiveRegion="polite">
          <EmptyState
            size="quiet"
            title={t('mobile.firstBoard.nearbyError')}
            actions={<TextAction reach="down" label={t('mobile.errorRetry')} onPress={onRetryNearby} />}
          />
        </View>
      );
    case 'location_off':
      return (
        <View accessibilityLiveRegion="polite">
          <EmptyState
            size="quiet"
            title={t('mobile.firstBoard.locationOff')}
            actions={
              canOpenAppSettings() ? (
                <TextAction reach="down" label={t('mobile.firstBoard.openSettings')} onPress={onOpenSettings} />
              ) : undefined
            }
          />
        </View>
      );
    case 'found':
      return null;
  }
}

const styles = StyleSheet.create({
  quietAction: {
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
  },
});
