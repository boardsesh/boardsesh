import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import type { BoardName } from '@boardsesh/shared-schema';
import type { FirstBoardGymState } from '../../lib/boards/first-board-gym-state';
import { NearbySearchStatus } from './NearbySearchStatus';
import { spacing } from '../../theme/tokens';

type FirstBoardChoiceProps = {
  /** What the "At a gym" choice shows under itself; see `firstBoardGymState`. */
  gymState: FirstBoardGymState;
  /** The Near you list, rendered under the gym choice while `gymState` is `found`. */
  nearbyResults: ReactNode;
  onGym: () => void;
  onOwn: () => void;
  /** My Spraywall: the add-a-wall wizard, for a wall the climber photographs. */
  onAddSprayWall: () => void;
  onFindGymOnMap: () => void;
  onOpenSettings: () => void;
  /** Asks for the boards near the climber again, after `nearby_error`. */
  onRetryNearby: () => void;
  /** The one board type the gym search is narrowed to, or null; see `NearbySearchStatus`. */
  nearbyBoardType?: BoardName | null;
  /** Drops `nearbyBoardType`. */
  onShowAllNearby?: () => void;
  /**
   * The add-a-board wizard is on: the cards are its step 1, answered here (At
   * a gym, At home, A spray wall), so they use its words. At a gym still lists
   * the boards near the climber right here, as before.
   */
  wizardCopy?: boolean;
};

/**
 * The first-board picker's body (#5654): "Where do you climb?" and the three
 * ways to a board, for a newcomer the launch gate brought here, or a climber
 * with no boards who tapped "Find my board" on Climbs.
 *
 * Three cards, because the question a newcomer can answer is where they climb,
 * not which discovery mode they want. Each answer leads straight to the flow
 * behind it: the boards near them and the gym map for a gym, the builder for a
 * home board, and the add-a-wall wizard for a Spraywall. The board in front of
 * them is the picker's In range slot, which sits above this block.
 *
 * Presentational: the screen owns location, the lists and navigation, and hands
 * in the gym state and callbacks. Cards are the app's variant-routed `Card`
 * (opaque on Liquid Glass, M3 elevated on Material), so glass stays on the
 * chrome.
 */
export function FirstBoardChoice({
  gymState,
  nearbyResults,
  onGym,
  onOwn,
  onAddSprayWall,
  onFindGymOnMap,
  onOpenSettings,
  onRetryNearby,
  nearbyBoardType = null,
  onShowAllNearby,
  wizardCopy = false,
}: FirstBoardChoiceProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="title2" accessibilityRole="header">
          {t('mobile.firstBoard.title')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.firstBoard.body')}
        </Text>
      </View>

      <ChoiceCard
        icon="gym"
        title={t('mobile.firstBoard.gym')}
        hint={t('mobile.firstBoard.gymHint')}
        onPress={onGym}
        busy={gymState === 'searching'}
      />
      {gymState === 'found' ? (
        <View style={styles.gymResults}>
          {nearbyResults}
          <View style={styles.gymPanel}>
            <Button title={t('mobile.firstBoard.findGymOnMap')} variant="text" onPress={onFindGymOnMap} />
          </View>
        </View>
      ) : (
        <NearbySearchStatus
          state={gymState}
          onFindGymOnMap={onFindGymOnMap}
          onOpenSettings={onOpenSettings}
          onRetryNearby={onRetryNearby}
          boardType={nearbyBoardType}
          onShowAll={onShowAllNearby}
        />
      )}

      <ChoiceCard
        icon="home"
        title={wizardCopy ? t('mobile.addWizard.home') : t('mobile.firstBoard.own')}
        hint={wizardCopy ? t('mobile.addWizard.homeHint') : t('mobile.firstBoard.ownHint')}
        onPress={onOwn}
      />
      <ChoiceCard
        icon="camera"
        title={wizardCopy ? t('mobile.addWizard.spray') : t('mobile.firstBoard.sprayWall')}
        hint={wizardCopy ? t('mobile.addWizard.sprayHint') : t('mobile.firstBoard.sprayWallHint')}
        onPress={onAddSprayWall}
      />
    </View>
  );
}

/**
 * One answer card: an icon, a title and a hint, a chevron (or a spinner while
 * `busy`). Exported for "Where's this board?" (#8151), which asks the same
 * kind of question and should read the same.
 */
export function ChoiceCard({
  icon,
  title,
  hint,
  onPress,
  busy = false,
}: {
  icon: IconName;
  title: string;
  hint: string;
  onPress: () => void;
  busy?: boolean;
}) {
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={styles.cardSlot}>
      <Card onPress={onPress} accessibilityLabel={`${title}. ${hint}`} accessibilityState={{ busy }}>
        <View style={styles.cardRow}>
          <Icon name={icon} size={28} color={brandColors.primary} />
          <View style={styles.cardText}>
            <Text variant="headline">{title}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {hint}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator size="small" />
          ) : (
            <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
          )}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing[3],
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    gap: spacing[2],
  },
  cardSlot: {
    paddingHorizontal: spacing[4],
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  cardText: {
    flex: 1,
    gap: spacing[1],
  },
  gymResults: {
    gap: spacing[2],
  },
  gymPanel: {
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
  },
});
