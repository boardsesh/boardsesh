import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { formatSprayArchiveDate } from '../../lib/spray/spray-archive-date';
import type { ArchivedSprayWallSummary } from './manage-items';

type ArchivedWallManageRowProps = {
  wall: ArchivedSprayWallSummary;
  isActive: boolean;
  /** Open the wall to browse and log its climbs. Stable: one callback for every row. */
  onOpen: (wallUuid: string) => void;
  /** Delete the wall, behind the screen's confirm. Stable: one callback for every row. */
  onDelete: (wall: ArchivedSprayWallSummary) => void;
};

/**
 * One archived spray wall in My Boards' Archived section: its name and when a
 * reset replaced it. Tapping it makes it the active board, so its climbs can be
 * browsed, sent and logged; nothing new can be set on it. The trailing trash
 * deletes it, the one way to make room under the archived-wall cap.
 */
export const ArchivedWallManageRow = memo(function ArchivedWallManageRow({
  wall,
  isActive,
  onOpen,
  onDelete,
}: ArchivedWallManageRowProps) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const date = formatSprayArchiveDate(wall.archivedAt, i18n.resolvedLanguage ?? i18n.language);
  const subtitle = date ? t('sprayArchive.manageRow', { date }) : t('sprayArchive.manageRowUndated');
  const open = useCallback(() => onOpen(wall.uuid), [onOpen, wall.uuid]);
  const remove = useCallback(() => onDelete(wall), [onDelete, wall]);

  return (
    <View style={[styles.row, { backgroundColor: systemColors.background, borderBottomColor: systemColors.separator }]}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`${wall.name}. ${subtitle}`}
        style={({ pressed }) => [styles.openArea, pressed ? styles.pressed : null]}
      >
        <Icon name="history" size={22} color={systemColors.secondaryLabel} />
        <View style={styles.textCol}>
          <Text variant="body" color={systemColors.label} numberOfLines={1}>
            {wall.name}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {isActive ? (
          <View style={styles.activeBadge}>
            <Icon name="tick" size={14} color={brandColors.primary} />
            <Text variant="caption1" color={brandColors.primary}>
              {t('mobile.boardDetail.alreadyActive')}
            </Text>
          </View>
        ) : (
          <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
        )}
      </Pressable>
      <Pressable
        onPress={remove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.manage.deleteAria', { name: wall.name })}
        style={({ pressed }) => [styles.deleteButton, pressed ? styles.pressed : null]}
      >
        <Icon name="delete" size={20} color={systemColors.secondaryLabel} />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  openArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[3],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
  },
  deleteButton: {
    padding: spacing[2],
  },
  pressed: {
    opacity: 0.5,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
});
