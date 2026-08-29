import { memo, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { BoardImageNative } from '../BoardImageNative';
import { boardRowSubtitle } from './board-labels';
import { BoardOfflineToggle } from './BoardOfflineToggle';
import type { BoardDownloadNotice, BoardDownloadProgress, BoardDownloadState } from './board-offline-state';
import { OfflineDownloadProgressBar } from './OfflineDownloadProgressBar';
import { getBoardRenderData } from '../../lib/board-details';
import { formatBytes } from '../../lib/format-bytes';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

const THUMB_SIZE = 56;

type BoardManageRowProps = {
  board: UserBoard;
  /**
   * True when the viewer owns this board. Still needed after the edit/delete
   * affordances moved to the picker's cards: it is what decides whether the
   * subtitle names the place or the owner.
   */
  isOwned: boolean;
  isActive: boolean;
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
  /**
   * Live byte/percent detail for the snapshot warm-up (issue #4311), for THIS
   * row only — null on every other row, so their memo holds while this one
   * re-renders. Null also covers a build where the progress flag is off or the
   * downloader emits nothing, in which case the row keeps the plain
   * "Downloading board…" caption.
   */
  downloadProgress?: BoardDownloadProgress | null;
  /** Durable context for a retrying snapshot or a paged-crawl fallback. */
  downloadNotice?: BoardDownloadNotice;
  /**
   * This board has settled onto the slow crawl and can be put back on the fast
   * download by hand (issue #4313). Shows an inline action under the caption —
   * the only escape from a settled scope short of removing and re-adding it.
   */
  canRetryFastDownload?: boolean;
  onRetryFastDownload?: (board: UserBoard) => void;
  onToggleOffline: (board: UserBoard) => void;
};

/**
 * One board in the management list: name, what it is, and its offline-download
 * console. Editing, deleting and unfollowing a board now live on the board cards
 * in the /boards picker, so this row is read-only apart from the download
 * toggle. Memoised; its props are referentially stable from the screen except
 * `board` (rebuilt on refetch), so it re-renders only when its own board data
 * changes.
 */
function BoardManageRowComponent({
  board,
  isOwned,
  isActive,
  downloadState,
  downloadCount,
  isBootstrapping,
  downloadProgress = null,
  downloadNotice = null,
  canRetryFastDownload = false,
  onRetryFastDownload,
  onToggleOffline,
}: BoardManageRowProps) {
  const { t, i18n } = useTranslation('boards');
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

  // Owned: where the board is (or what it is) tells one of your walls apart.
  // Followed: whose board it is — the group header only says "Following", it
  // names nobody, and the picker's cards never show an owner either, so this is
  // the one place in the app that answers "whose board is this".
  const subtitle = isOwned ? boardRowSubtitle(board) : (board.ownerDisplayName ?? boardRowSubtitle(board));

  // Live bootstrap always wins over persisted history: the engine may retry a
  // scope whose previous run selected a paged fallback, and showing both would
  // contradict what is happening now.
  const effectiveDownloadNotice = isBootstrapping ? null : downloadNotice;
  const showsPagedFallbackCount = effectiveDownloadNotice === 'paged-fallback' && downloadState === 'downloading';

  // The staged bootstrap caption (issue #4311). Every byte figure comes from the
  // engine on the WIRE scale, so this renders the same number the enable-confirm
  // dialog quoted. Falls back to the plain "Downloading board…" string whenever
  // there is no frame yet — first render, flag off, or a downloader that never
  // reports.
  const bootstrapProgressStatus =
    isBootstrapping && downloadProgress
      ? downloadProgress.stage === 'manifest'
        ? t('mobile.offline.bootstrapPreparing')
        : downloadProgress.stage === 'import'
          ? t('mobile.offline.bootstrapImporting')
          : downloadProgress.bytesDone !== null && downloadProgress.bytesTotal !== null
            ? t('mobile.offline.bootstrapDownloading', {
                done: formatBytes(downloadProgress.bytesDone, i18n.language),
                total: formatBytes(downloadProgress.bytesTotal, i18n.language),
              })
            : t('mobile.offline.bootstrapDownloadingUnknown', {
                total: formatBytes(downloadProgress.bytesTotal ?? 0, i18n.language),
              })
      : null;

  const offlineStatus =
    effectiveDownloadNotice === 'snapshot-retrying'
      ? t('mobile.offline.snapshotRetrying')
      : effectiveDownloadNotice === 'paged-fallback'
        ? showsPagedFallbackCount
          ? t('mobile.offline.pagedFallbackActive')
          : t('mobile.offline.pagedFallbackPending')
        : downloadState === 'downloading'
          ? isBootstrapping
            ? (bootstrapProgressStatus ?? t('mobile.offline.bootstrapping'))
            : t('mobile.offline.downloadingCount', { count: downloadCount ?? 0 })
          : downloadState === 'downloaded'
            ? t('mobile.offline.available')
            : downloadState === 'finalizing'
              ? t('mobile.offline.finalizing')
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

  return (
    <View style={[styles.row, { backgroundColor: systemColors.background, borderBottomColor: systemColors.separator }]}>
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
        {/* Rendered unconditionally when the row can download at all, so the
            first progress frame cannot change the row's height inside the
            FlashList and jump the scroll position. */}
        {downloadState !== undefined ? (
          <OfflineDownloadProgressBar
            fraction={downloadProgress && downloadProgress.stage === 'download' ? downloadProgress.fraction : undefined}
          />
        ) : null}
        {canRetryFastDownload && onRetryFastDownload ? (
          <Pressable
            onPress={() => onRetryFastDownload(board)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.offline.retryFastDownloadAria', { name: board.name })}
            style={({ pressed }) => [styles.retryFastDownload, pressed && styles.pressed]}
          >
            <Text variant="caption1" color={brandColors.primary}>
              {t('mobile.offline.retryFastDownload')}
            </Text>
          </Pressable>
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
    </View>
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
  pressed: {
    opacity: 0.5,
  },
  retryFastDownload: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
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
