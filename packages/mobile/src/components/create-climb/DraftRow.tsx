import { useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { countHolds } from './draft-format';
import { formatRelativeTime } from '../../lib/format-relative-time';

type DraftRowProps = {
  climb: Climb;
  onPress: (climb: Climb) => void;
  onDelete: (climb: Climb) => void;
};

/**
 * A single draft row: name (or "Draft"), a "{holds} · {relative time}" subtitle,
 * and a destructive delete button. Extracted so the inline drafts section and
 * any other draft list render identical rows.
 */
export function DraftRow({ climb, onPress, onDelete }: DraftRowProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  const holdCount = countHolds(climb.frames);
  const relative = formatRelativeTime(climb.created_at);
  const subtitleParts = [t('mobile.create.drafts.holds', { count: holdCount }), relative].filter(Boolean);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(climb);
  }, [climb, onPress]);

  return (
    <View style={styles.row}>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={climb.name || t('createClimbForm.draftBadge')}
        style={styles.rowMain}
      >
        <Text variant="body" numberOfLines={1}>
          {climb.name || t('createClimbForm.draftBadge')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
          {subtitleParts.join(' · ')}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onDelete(climb)}
        accessibilityRole="button"
        accessibilityLabel={t('draftsDrawer.delete.tooltip')}
        hitSlop={8}
        style={styles.deleteButton}
      >
        <Icon name="delete" size={20} color={iosSystemColors.systemRed} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: iosSystemColors.separator,
    gap: spacing[2],
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  deleteButton: {
    padding: spacing[2],
    borderRadius: borderRadius.md,
  },
});
