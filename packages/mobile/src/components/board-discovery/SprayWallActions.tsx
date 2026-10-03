import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useSprayWallsEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { sprayDetailRows, sprayShareTarget, type SprayDetailRowKey } from './spray-detail-rows';

type SprayWallActionsProps = {
  board: UserBoard | null;
  onOpenMaintenance?: (wallUuid: string, action: SprayDetailRowKey) => void;
  onShare?: (wallUuid: string) => void;
};

/** Static actions inside the live board sheet's virtualized list header. */
export const SprayWallActions = memo(function SprayWallActions({
  board,
  onOpenMaintenance,
  onShare,
}: SprayWallActionsProps) {
  const { t } = useTranslation('boards');
  const enabled = useSprayWallsEnabled();
  const { systemColors } = useTheme();
  const maintenanceRows = useMemo(() => (enabled ? sprayDetailRows(board) : []), [board, enabled]);
  const shareTarget = useMemo(() => (enabled ? sprayShareTarget(board) : null), [board, enabled]);
  const wallUuid = board?.uuid;
  const editHolds = useCallback(() => {
    if (wallUuid) onOpenMaintenance?.(wallUuid, 'editHolds');
  }, [onOpenMaintenance, wallUuid]);
  const newPhoto = useCallback(() => {
    if (wallUuid) onOpenMaintenance?.(wallUuid, 'newPhoto');
  }, [onOpenMaintenance, wallUuid]);
  const share = useCallback(() => {
    if (wallUuid) onShare?.(wallUuid);
  }, [onShare, wallUuid]);

  if ((!onOpenMaintenance || maintenanceRows.length === 0) && (!onShare || !shareTarget)) return null;

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      {onOpenMaintenance && maintenanceRows.length > 0 ? (
        <>
          {maintenanceRows.some((row) => row.key === 'editHolds') ? (
            <WallActionRow
              icon="edit"
              label={t('mobile.boardDetail.spray.editHolds')}
              hint={t('mobile.boardDetail.spray.editHoldsHint')}
              onPress={editHolds}
            />
          ) : null}
          {maintenanceRows.some((row) => row.key === 'newPhoto') ? (
            <WallActionRow
              icon="camera"
              label={t('mobile.boardDetail.spray.newPhoto')}
              hint={t('mobile.boardDetail.spray.newPhotoHint')}
              onPress={newPhoto}
            />
          ) : null}
        </>
      ) : null}
      {onShare && shareTarget ? (
        <WallActionRow
          icon="share"
          label={t('mobile.boardDetail.spray.shareLink')}
          hint={
            shareTarget.visibility === 'public'
              ? t('mobile.boardDetail.spray.shareLinkPublicHint')
              : t('mobile.boardDetail.spray.shareLinkUnlistedHint')
          }
          onPress={share}
          separator={onOpenMaintenance != null && maintenanceRows.length > 0}
        />
      ) : null}
    </View>
  );
});

const WallActionRow = memo(function WallActionRow({
  icon,
  label,
  hint,
  onPress,
  separator = false,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
  separator?: boolean;
}) {
  const { systemColors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        separator ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator } : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      <View style={styles.copy}>
        <Text variant="body" color={systemColors.label}>
          {label}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {hint}
        </Text>
      </View>
      <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: borderRadius.lg, overflow: 'hidden', marginVertical: spacing[3] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], padding: spacing[4], minHeight: 44 },
  copy: { flex: 1, gap: spacing[1] },
  pressed: { opacity: 0.6 },
});
