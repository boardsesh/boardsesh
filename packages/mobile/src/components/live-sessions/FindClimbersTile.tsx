import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { borderRadius, spacing } from '../../theme/tokens';
import { LIVE_TILE_WIDTH } from './live-session-model';
import { useLiveSessionColors } from './use-live-session-colors';

const ACTION_HEIGHT = 44;

type FindClimbersTileProps = {
  height: number;
  onPress: () => void;
};

/**
 * "Bring your crew". A rail fed by follows stays empty for someone who follows
 * nobody, so this leads the rail for them and trails an empty rail otherwise.
 */
export const FindClimbersTile = memo(function FindClimbersTile({ height, onPress }: FindClimbersTileProps) {
  const { t } = useTranslation('feed');
  const colors = useLiveSessionColors();
  const title = t('mobile.liveSessions.find.title');
  const body = t('mobile.liveSessions.find.body');

  return (
    <PressableSurface
      testID="live-sessions-find-tile"
      onPress={onPress}
      feedback="scale"
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      style={[styles.tile, { height, backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View
        style={[styles.iconCircle, { backgroundColor: colors.tintFill }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name="person.badge.plus" size={20} color={colors.primary} />
      </View>
      <Text variant="headline" color={colors.label} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      <Text variant="footnote" color={colors.meta} numberOfLines={2}>
        {body}
      </Text>
      <View style={styles.spacer} />
      <View style={[styles.cta, { backgroundColor: colors.tintFill, borderColor: colors.tintBorder }]}>
        <Text variant="subheadline" color={colors.primary} numberOfLines={1} style={styles.bold}>
          {t('mobile.liveSessions.find.cta')}
        </Text>
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  tile: {
    width: LIVE_TILE_WIDTH,
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  bold: { fontWeight: '700' },
});
