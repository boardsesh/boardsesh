import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { LIVE_TILE_WIDTH } from './live-session-model';
import { useLiveSessionColors } from './use-live-session-colors';

export type StartPromptVariant = 'default' | 'ble_connected';

const AVATAR_SIZE = 36;
const ACTION_HEIGHT = 44;

type StartSessionTileProps = {
  variant: StartPromptVariant;
  /** The board the climber is connected to (ble_connected variant only). */
  boardName: string | null;
  viewerName: string | null;
  viewerAvatarUrl: string | null;
  height: number;
  onPress: (variant: StartPromptVariant) => void;
};

/**
 * The rail's invitation to start a session: last when people are live, first
 * when nobody is. The whole tile is the press target; the filled capsule is
 * its visual button.
 */
export const StartSessionTile = memo(function StartSessionTile({
  variant,
  boardName,
  viewerName,
  viewerAvatarUrl,
  height,
  onPress,
}: StartSessionTileProps) {
  const { t } = useTranslation('feed');
  const { colorScheme } = useTheme();
  const colors = useLiveSessionColors();
  const bleConnected = variant === 'ble_connected' && boardName != null;
  const title = bleConnected
    ? t('mobile.liveSessions.start.bleTitle', { board: boardName })
    : t('mobile.liveSessions.start.title');
  const body = bleConnected ? t('mobile.liveSessions.start.bleBody') : t('mobile.liveSessions.start.body');
  const cta = t('mobile.liveSessions.start.cta');

  return (
    <PressableSurface
      testID="live-sessions-start-tile"
      onPress={() => onPress(bleConnected ? 'ble_connected' : 'default')}
      feedback="scale"
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      style={[
        styles.tile,
        {
          height,
          backgroundColor: withAlpha(colors.primaryFill, colorScheme === 'dark' ? 0.16 : 0.08),
          borderColor: withAlpha(colors.primaryFill, 0.45),
        },
      ]}
    >
      <View style={styles.headRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Avatar uri={viewerAvatarUrl} name={viewerName} size={AVATAR_SIZE} />
        <View style={[styles.openSeat, { borderColor: colors.meta }]}>
          <Icon name="plus" size={14} color={colors.meta} />
        </View>
        <View style={[styles.openSeat, { borderColor: colors.meta }]}>
          <Icon name="plus" size={14} color={colors.meta} />
        </View>
      </View>
      <Text variant="headline" color={colors.label} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      <Text variant="footnote" color={colors.meta} numberOfLines={2}>
        {body}
      </Text>
      <View style={styles.spacer} />
      <View style={[styles.cta, { backgroundColor: colors.primaryFill }]}>
        <Icon name="record" size={18} color={colors.onPrimary} />
        <Text variant="subheadline" color={colors.onPrimary} numberOfLines={1} style={styles.bold}>
          {cta}
        </Text>
      </View>
    </PressableSurface>
  );
});

type StartSessionRowProps = {
  onPress: () => void;
};

/** The 56pt row the Start tile shrinks to after three ignored days. */
export const StartSessionRow = memo(function StartSessionRow({ onPress }: StartSessionRowProps) {
  const { t } = useTranslation('feed');
  const colors = useLiveSessionColors();
  const label = t('mobile.liveSessions.start.title');
  return (
    <PressableSurface
      testID="live-sessions-start-row"
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Icon name="record" size={20} color={colors.primary} />
      <Text variant="body" color={colors.label} numberOfLines={1} style={styles.rowLabel}>
        {label}
      </Text>
      <Icon name="chevron.right" size={16} color={colors.meta} />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  tile: {
    width: LIVE_TILE_WIDTH,
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  headRow: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  openSeat: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    marginTop: spacing[2],
  },
  spacer: { flex: 1, minHeight: spacing[2] },
  cta: {
    alignSelf: 'flex-end',
    height: ACTION_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
  },
  bold: { fontWeight: '700' },
  row: {
    marginHorizontal: spacing[4],
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    flex: 1,
  },
});
