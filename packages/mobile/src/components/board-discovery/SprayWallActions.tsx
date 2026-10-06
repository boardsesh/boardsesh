import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { useSprayWallArchiveState } from '../../lib/spray/use-spray-wall-archive';
import { SprayWallArchivedBanner } from '../spray-wall/SprayWallArchivedBanner';
import { sprayDetailRows, sprayShareTarget, type SprayDetailRowKey } from './spray-detail-rows';

type SprayWallActionsProps = {
  board: UserBoard | null;
  onOpenMaintenance?: (wallUuid: string, action: SprayDetailRowKey) => void;
  onShare?: (wallUuid: string) => void;
  /** The signed-in climber's id: the reset rows are the wall owner's alone. */
  viewerUserId?: string | null;
};

/**
 * Static actions inside the live board sheet's virtualized list header, under
 * the archived-wall notice when the wall is archived.
 */
export const SprayWallActions = memo(function SprayWallActions({
  board,
  onOpenMaintenance,
  onShare,
  viewerUserId = null,
}: SprayWallActionsProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const archive = useSprayWallArchiveState(board?.boardType, board?.layoutId ?? null);
  const maintenanceRows = useMemo(
    () => sprayDetailRows(board, { viewerUserId, archive }),
    [board, viewerUserId, archive],
  );
  const shareTarget = useMemo(() => sprayShareTarget(board), [board]);
  const wallUuid = board?.uuid;
  const editHolds = useCallback(() => {
    if (wallUuid) onOpenMaintenance?.(wallUuid, 'editHolds');
  }, [onOpenMaintenance, wallUuid]);
  const holdsLocked = useCallback(() => {
    if (wallUuid) onOpenMaintenance?.(wallUuid, 'holdsLocked');
  }, [onOpenMaintenance, wallUuid]);
  const resetWall = useCallback(() => {
    if (wallUuid) onOpenMaintenance?.(wallUuid, 'resetWall');
  }, [onOpenMaintenance, wallUuid]);
  const share = useCallback(() => {
    if (wallUuid) onShare?.(wallUuid);
  }, [onShare, wallUuid]);

  const banner = <SprayWallArchivedBanner boardName={board?.boardType} layoutId={board?.layoutId ?? null} />;
  const showMaintenance = onOpenMaintenance != null && maintenanceRows.length > 0;
  const showShare = onShare != null && shareTarget != null;
  if (!showMaintenance && !showShare) return archive?.archivedAt ? <View style={styles.block}>{banner}</View> : null;

  const lockedRow = maintenanceRows.find((row) => row.key === 'holdsLocked');

  return (
    <View style={styles.block}>
      {banner}
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        {showMaintenance ? (
          <>
            {maintenanceRows.some((row) => row.key === 'editHolds') ? (
              <WallActionRow
                icon="edit"
                label={t('mobile.boardDetail.spray.editHolds')}
                hint={t('mobile.boardDetail.spray.editHoldsHint')}
                onPress={editHolds}
              />
            ) : null}
            {lockedRow ? (
              <WallActionRow
                icon="lock"
                label={t('mobile.boardDetail.spray.holdsLocked')}
                hint={t('mobile.boardDetail.spray.holdsLockedHint')}
                // Only the owner can act on it; for anyone else it says why
                // Edit holds is gone and leads nowhere.
                onPress={lockedRow.href ? holdsLocked : undefined}
                separator={maintenanceRows[0]?.key !== 'holdsLocked'}
              />
            ) : null}
            {maintenanceRows.some((row) => row.key === 'resetWall') ? (
              <WallActionRow
                icon="camera"
                label={t('mobile.boardDetail.spray.resetWall')}
                hint={t('mobile.boardDetail.spray.resetWallHint')}
                onPress={resetWall}
                separator={maintenanceRows[0]?.key !== 'resetWall'}
              />
            ) : null}
          </>
        ) : null}
        {showShare ? (
          <WallActionRow
            icon="share"
            label={t('mobile.boardDetail.spray.shareLink')}
            hint={
              shareTarget.visibility === 'public'
                ? t('mobile.boardDetail.spray.shareLinkPublicHint')
                : t('mobile.boardDetail.spray.shareLinkUnlistedHint')
            }
            onPress={share}
            separator={showMaintenance}
          />
        ) : null}
      </View>
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
  /** Left out for a row that only informs: no button role, no chevron. */
  onPress?: () => void;
  separator?: boolean;
}) {
  const { systemColors } = useTheme();
  const separatorStyle = separator
    ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator }
    : null;
  const content = (
    <>
      <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      <View style={styles.copy}>
        <Text variant="body" color={systemColors.label}>
          {label}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {hint}
        </Text>
      </View>
      {onPress ? <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.row, separatorStyle]} accessible accessibilityLabel={`${label}. ${hint}`}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.row, separatorStyle, pressed ? styles.pressed : null]}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  block: { gap: spacing[3], marginVertical: spacing[3] },
  card: { borderRadius: borderRadius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], padding: spacing[4], minHeight: 44 },
  copy: { flex: 1, gap: spacing[1] },
  pressed: { opacity: 0.6 },
});
