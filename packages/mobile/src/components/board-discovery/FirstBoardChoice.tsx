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
  onScan: () => void;
  onFindGymOnMap: () => void;
  onOpenSettings: () => void;
  /** Asks for the boards near the climber again, after `nearby_error`. */
  onRetryNearby: () => void;
  /**
   * "Add my spray wall", under My own board. Only passed when the spray-walls
   * flag is on: the builder behind My own board cannot make a spray wall, so
   * without it a home spray-wall owner with no boards has no way forward here.
   */
  onAddSprayWall?: () => void;
};

/**
 * The first-board picker's body (#5654): "Where do you climb?" and the three
 * ways to a board, for a newcomer the launch gate brought here, or a climber
 * with no boards who tapped "Find my board" on Climbs.
 *
 * Two cards and a text button rather than the picker's row of five equal tiles,
 * because the question a newcomer can answer is where they climb, not which
 * discovery mode they want. Each answer leads straight to the existing flow
 * behind it: Find nearby and the gym map for a gym, the builder for a home
 * wall, and the Bluetooth quickstart for the board in front of them.
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
  onScan,
  onFindGymOnMap,
  onOpenSettings,
  onRetryNearby,
  onAddSprayWall,
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
        />
      )}

      <ChoiceCard
        icon="home"
        title={t('mobile.firstBoard.own')}
        hint={t('mobile.firstBoard.ownHint')}
        onPress={onOwn}
      />
      {onAddSprayWall ? (
        <View style={styles.textAction}>
          <Button title={t('mobile.firstBoard.sprayWall')} variant="text" icon="camera" onPress={onAddSprayWall} />
        </View>
      ) : null}

      <View style={styles.scan}>
        <Button title={t('mobile.firstBoard.scan')} variant="text" icon="bluetooth" onPress={onScan} />
        {/* Always visible, not only after a scan comes up empty: the scan cannot
            see MoonBoards or boxes that don't advertise a serial, and a climber
            standing at one should know that before they wait on it. */}
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footnote}>
          {t('mobile.firstBoard.scanFootnote')}
        </Text>
      </View>
    </View>
  );
}

function ChoiceCard({
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
  scan: {
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
    gap: spacing[1],
  },
  textAction: {
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
  },
  footnote: {
    paddingHorizontal: spacing[1],
  },
});
