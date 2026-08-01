import { memo, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { SwipeableRow } from '../SwipeableRow';
import { BoardImageNative } from '../BoardImageNative';
import { boardTypeLabel } from './board-builder-labels';
import { BoardOfflineToggle } from './BoardOfflineToggle';
import type { BoardDownloadNotice, BoardDownloadState } from './board-offline-state';
import { getBoardRenderData } from '../../lib/board-details';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

const THUMB_SIZE = 56;

type BoardManageRowProps = {
  board: UserBoard;
  /** True when the user owns this board (edit/delete); false for followed boards (unfollow). */
  isOwned: boolean;
  isActive: boolean;
  /**
   * Edit mode (from the header "Edit" button): show a persistent leading remove
   * control (Delete for owned, Unfollow for followed) and disable the swipe, so the
   * destructive action never depends on the hard-to-hit swipe gesture.
   */
  isEditing?: boolean;
  /**
   * No network: hide every affordance that is a server mutation (tap-to-edit, the
   * swipe delete/unfollow) and leave only the local offline toggle. The row still
   * shows the board, its subtitle and its download status.
   */
  readOnly?: boolean;
  /** A mutation targeting this row is in flight — show a spinner and disable the swipe. */
  isMutating: boolean;
  /**
   * Offline download state for this board's (type, layout, size) scope.
   * `undefined` means offline downloads are unavailable (feature-flagged off) —
   * the toggle and status caption are not rendered at all.
   */
  downloadState: BoardDownloadState | undefined;
  /** Climbs pulled so far while this board is the one downloading (paged crawl only). */
  downloadCount?: number;
  /**
   * True while `downloadState === 'downloading'` is the snapshot-bootstrap
   * warm-up rather than the paged crawl — shows a distinct "Downloading
   * board…" caption instead of a live climb count (the bootstrap phase has
   * no per-row count to show).
   */
  isBootstrapping?: boolean;
  /** Durable context for a retrying snapshot or a paged-crawl fallback. */
  downloadNotice?: BoardDownloadNotice;
  onEdit: (board: UserBoard) => void;
  onDelete: (board: UserBoard) => void;
  onUnfollow: (board: UserBoard) => void;
  onToggleOffline: (board: UserBoard) => void;
};

/**
 * One board in the management list. Owned boards open the edit form on tap and
 * reveal Delete on swipe; followed boards reveal Unfollow on swipe (no tap
 * target — switching/activating lives on the board picker, not here). Memoised;
 * its props are referentially stable from the screen except `board` (rebuilt on
 * refetch), so it re-renders only when its own board data changes.
 */
function BoardManageRowComponent({
  board,
  isOwned,
  isActive,
  isEditing = false,
  readOnly = false,
  isMutating,
  downloadState,
  downloadCount,
  isBootstrapping,
  downloadNotice = null,
  onEdit,
  onDelete,
  onUnfollow,
  onToggleOffline,
}: BoardManageRowProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const boardName = toBoardName(board.boardType);
  const renderData = useMemo(() => {
    if (!boardName) return null;
    const setIdValues = board.setIds.split(',').map(Number).filter(Number.isFinite);
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({ boardName, layoutId: board.layoutId, sizeId: board.sizeId, setIds: setIdValues });
  }, [boardName, board.layoutId, board.sizeId, board.setIds]);

  // Board art isn't square; fit it inside the square thumb at its native aspect
  // (passing height:'100%' would override BoardImageNative's aspectRatio and stretch it).
  const thumbFit = useMemo(() => {
    if (!renderData) return null;
    const aspect = renderData.boardWidth / renderData.boardHeight;
    return aspect >= 1
      ? { width: THUMB_SIZE, height: THUMB_SIZE / aspect }
      : { width: THUMB_SIZE * aspect, height: THUMB_SIZE };
  }, [renderData]);

  // Proper-cased board name for trademark correctness when used as a fallback.
  const boardTypeText = boardName ? boardTypeLabel(boardName) : board.boardType;
  // Owned: size / location tells one of your walls apart. Followed: whose board it is.
  const subtitle = isOwned
    ? (board.sizeName ?? board.locationName ?? boardTypeText)
    : (board.ownerDisplayName ?? boardTypeText);

  // Live bootstrap always wins over persisted history: the engine may retry a
  // scope whose previous run selected a paged fallback, and showing both would
  // contradict what is happening now.
  const effectiveDownloadNotice = isBootstrapping ? null : downloadNotice;
  const showsPagedFallbackCount = effectiveDownloadNotice === 'paged-fallback' && downloadState === 'downloading';
  const offlineStatus =
    effectiveDownloadNotice === 'snapshot-retrying'
      ? t('mobile.offline.snapshotRetrying')
      : effectiveDownloadNotice === 'paged-fallback'
        ? showsPagedFallbackCount
          ? t('mobile.offline.pagedFallbackActive')
          : t('mobile.offline.pagedFallbackPending')
        : downloadState === 'downloading'
          ? isBootstrapping
            ? t('mobile.offline.bootstrapping')
            : t('mobile.offline.downloadingCount', { count: downloadCount ?? 0 })
          : downloadState === 'downloaded'
            ? t('mobile.offline.available')
            : downloadState === 'pending'
              ? t('mobile.offline.pending')
              : null;

  const offlineStatusAccessibilityLabel =
    effectiveDownloadNotice === 'snapshot-retrying'
      ? t('mobile.offline.snapshotRetryingAria', { name: board.name })
      : effectiveDownloadNotice === 'paged-fallback'
        ? showsPagedFallbackCount
          ? t('mobile.offline.pagedFallbackActiveAria', { name: board.name })
          : t('mobile.offline.pagedFallbackPendingAria', { name: board.name })
        : undefined;
  const pagedFallbackProgress = showsPagedFallbackCount
    ? t('mobile.offline.downloadingCount', { count: downloadCount ?? 0 })
    : null;

  // Android's polite live region handles semantic notice transitions. React
  // Native does not implement that prop for iOS, so announce the same localized
  // label imperatively there. Seed the ref from the first render to avoid every
  // persisted fallback row speaking when a virtualized list mounts; later
  // appearance, kind/state change, or locale change announces once. The live
  // count is deliberately absent from the label, so count-only frames stay quiet.
  const previousNoticeLabelRef = useRef(offlineStatusAccessibilityLabel);
  useEffect(() => {
    const previousNoticeLabel = previousNoticeLabelRef.current;
    previousNoticeLabelRef.current = offlineStatusAccessibilityLabel;
    if (
      Platform.OS === 'ios' &&
      offlineStatusAccessibilityLabel !== undefined &&
      offlineStatusAccessibilityLabel !== previousNoticeLabel
    ) {
      AccessibilityInfo.announceForAccessibility(offlineStatusAccessibilityLabel);
    }
  }, [offlineStatusAccessibilityLabel]);

  const offlineToggleAria =
    downloadState === 'downloaded'
      ? t('mobile.offline.removeAria', { name: board.name })
      : t('mobile.offline.makeAvailableAria', { name: board.name });

  const content = (
    <View style={[styles.row, { backgroundColor: systemColors.background, borderBottomColor: systemColors.separator }]}>
      {isEditing ? (
        <Pressable
          onPress={isOwned ? () => onDelete(board) : () => onUnfollow(board)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            isOwned
              ? t('mobile.manage.deleteAria', { name: board.name })
              : t('mobile.manage.unfollowAria', { name: board.name })
          }
          style={({ pressed }) => [styles.removeControl, pressed && styles.pressed]}
        >
          <Icon name="minus.circle" size={24} color={iosSystemColors.systemRed} />
        </Pressable>
      ) : null}

      <View
        style={[
          styles.thumb,
          {
            backgroundColor: systemColors.tertiaryBackground,
            borderColor: isActive ? brandColors.primary : systemColors.separator,
            borderWidth: isActive ? 2 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        {renderData && boardName && thumbFit ? (
          // 400px source matches the discovery cards / climb thumbnails so the
          // board-art cache entry is shared across surfaces.
          <BoardImageNative
            frames=""
            boardName={boardName}
            layoutId={board.layoutId}
            sizeId={board.sizeId}
            setIds={board.setIds}
            boardWidth={renderData.boardWidth}
            boardHeight={renderData.boardHeight}
            renderWidth={400}
            style={thumbFit}
          />
        ) : (
          <Icon name="boards" size={26} color={systemColors.tertiaryLabel} />
        )}
      </View>

      <View style={styles.textCol}>
        <Text variant="body" numberOfLines={1}>
          {board.name}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
          {subtitle}
        </Text>
        {offlineStatus ? (
          <Text
            variant="caption1"
            color={downloadState === 'downloaded' ? brandColors.primary : systemColors.tertiaryLabel}
            numberOfLines={effectiveDownloadNotice ? undefined : 1}
            accessibilityLabel={offlineStatusAccessibilityLabel}
            accessibilityLiveRegion={Platform.OS === 'android' && effectiveDownloadNotice ? 'polite' : undefined}
          >
            {offlineStatus}
          </Text>
        ) : null}
        {pagedFallbackProgress ? (
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1} accessibilityLiveRegion="none">
            {pagedFallbackProgress}
          </Text>
        ) : null}
      </View>

      {downloadState !== undefined ? (
        <BoardOfflineToggle
          state={downloadState}
          onPress={() => onToggleOffline(board)}
          accessibilityLabel={offlineToggleAria}
        />
      ) : null}

      {isActive ? (
        <View style={styles.activeBadge}>
          <Icon name="tick" size={14} color={brandColors.primary} />
          <Text variant="caption1" color={brandColors.primary}>
            {t('mobile.boardDetail.alreadyActive')}
          </Text>
        </View>
      ) : null}

      {isMutating ? (
        <ActivityIndicator size="small" />
      ) : !isEditing && !readOnly && isOwned ? (
        <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
      ) : null}
    </View>
  );

  return (
    <SwipeableRow
      onPress={isOwned && !isEditing && !readOnly ? () => onEdit(board) : undefined}
      pressAccessibilityLabel={
        isOwned && !isEditing && !readOnly ? t('mobile.manage.editAria', { name: board.name }) : undefined
      }
      onAction={isOwned ? () => onDelete(board) : () => onUnfollow(board)}
      actionLabel={
        isOwned
          ? t('mobile.manage.deleteAria', { name: board.name })
          : t('mobile.manage.unfollowAria', { name: board.name })
      }
      actionIcon={isOwned ? 'delete' : 'minus.circle'}
      actionColor={isOwned ? iosSystemColors.systemRed : iosSystemColors.systemOrange}
      enabled={!isMutating && !isEditing && !readOnly}
      resetKey={board.uuid}
    >
      {content}
    </SwipeableRow>
  );
}

export const BoardManageRow = memo(BoardManageRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  removeControl: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 28,
  },
  pressed: {
    opacity: 0.5,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
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
