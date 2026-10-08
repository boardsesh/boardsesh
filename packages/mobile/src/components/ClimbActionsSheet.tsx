import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import type { AuroraBoardName, BoardName, Climb } from '@boardsesh/shared-schema';
import { getBoardCapabilities, toAuroraBoardName } from '@boardsesh/board-config';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import { canEditClimb } from '@boardsesh/create-climb-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ModalSheet } from './ModalSheet';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from './create-climb/use-create-climb-navigation';
import { ClimbPreviewCard } from './ClimbPreviewCard';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { useToast } from '../providers/toast-provider';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { CLIMB_SHARE_BASE_URL } from '../lib/env';
import { track } from '../lib/analytics';
import { useSprayWallIsArchived } from '../lib/spray/use-spray-wall-archive';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../providers/sheet-presentation-provider';
import { canDeleteClimb } from './climb-actions/delete-climb-rules';
import { useDeleteClimbAction } from './climb-actions/use-delete-climb-action';
import { MEDIUM_LARGE_SNAP_POINTS } from './sheet-snap-points';

type ClimbActionsSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  /** Current signed-in user id — gates the owner-only Edit row. */
  currentUserId?: string | null;
  onAddToQueue?: () => void;
  onOpenPlaylist?: () => void;
  onToggleFavorite?: () => void;
  /** When provided, shows a "Log a tick" row that opens the LogAscent sheet. */
  onTick?: () => void;
  /** When provided, shows an "Edit entry" row that opens the logbook edit sheet
   *  for the tick this climb was opened from (logbook context only). */
  onEditEntry?: () => void;
  /** When provided, shows an "Add beta video" row that opens the share-your-beta sheet. */
  onAddBetaVideo?: () => void;
  /** When provided, shows a "Report climb" row that opens the report sheet
   *  (hide the climb, or argue its grade). The caller gates it on auth + the
   *  moderation kill switch. */
  onReportClimb?: () => void;
  /**
   * When provided, shows "Open the queue", which opens it once this sheet has
   * gone. The play drawer passes it while the connect-step pill (#5654) has
   * taken the queue button's place in its second row.
   */
  onOpenQueue?: () => void;
  /** When provided, shows "Share" (the native share sheet); same condition as `onOpenQueue`. */
  onShare?: () => void;
  /** Supplied only by the `/play` route; omitted by the persistent iPad pane. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
  /**
   * Runs after the setter deletes this climb from the "Delete climb" row (#5960).
   * The play drawer closes itself here, since the climb it shows is gone.
   */
  onClimbDeleted?: () => void;
  onClose: () => void;
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
// Aurora-only by construction — the caller gates on the auroraAppLink capability
// and narrows the board name before calling, so a code-driven board (MoonBoard,
// Woods) never reaches this and never gets a URL at a domain that does not exist.
function buildAuroraAppUrl(boardName: AuroraBoardName, climbUuid: string): string | null {
  if (boardName === 'kilter') return null;
  const suffix = boardName === 'tension' ? '2' : '';
  return `https://${boardName}boardapp${suffix}.com/climbs/${climbUuid}`;
}

function ClimbActionsSheet({
  visible,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  currentUserId,
  onAddToQueue,
  onOpenPlaylist,
  onToggleFavorite,
  onTick,
  onEditEntry,
  onAddBetaVideo,
  onReportClimb,
  onOpenQueue,
  onShare,
  dismissPlayerAndWait,
  onClimbDeleted,
  onClose,
}: ClimbActionsSheetProps) {
  const { t } = useTranslation('climbs');
  const managedSheetRef = useRef<ManagedSheetHandle>(null);
  const dismissActionsSheetAndWait = useCallback(() => dismissManagedSheetAndWait(managedSheetRef.current), []);
  const { openRemix, openEdit, resetActionGuard } = useCreateClimbNavigation({
    dismissSourceSheet: dismissActionsSheetAndWait,
    dismissPlayerAndWait,
  });
  // PlayDrawer keeps this sheet mounted after first use. Re-arm only when a NEW
  // presentation opens; do not reset on close while the old sheet is still
  // hit-testable during its dismiss animation.
  useEffect(() => {
    if (visible) resetActionGuard();
  }, [visible, resetActionGuard]);
  const { showToast } = useToast();
  const theme = useTheme();

  const handleAddToQueue = useCallback(() => {
    onAddToQueue?.();
    onClose();
  }, [onAddToQueue, onClose]);

  const handleOpenPlaylist = useCallback(() => {
    onOpenPlaylist?.();
    onClose();
  }, [onOpenPlaylist, onClose]);

  const handleToggleFavorite = useCallback(() => {
    onToggleFavorite?.();
    onClose();
  }, [onToggleFavorite, onClose]);

  const handleTick = useCallback(() => {
    onTick?.();
    onClose();
  }, [onTick, onClose]);

  const handleEditEntry = useCallback(() => {
    onEditEntry?.();
    onClose();
  }, [onEditEntry, onClose]);

  const handleAddBetaVideo = useCallback(() => {
    onAddBetaVideo?.();
    onClose();
  }, [onAddBetaVideo, onClose]);

  const handleReportClimb = useCallback(() => {
    onReportClimb?.();
    onClose();
  }, [onReportClimb, onClose]);

  // The queue is another sheet, so it waits until this one has really gone
  // rather than presenting over its dismiss animation.
  const handleOpenQueue = useCallback(() => {
    if (!onOpenQueue) return;
    void dismissActionsSheetAndWait().then(() => {
      onClose();
      onOpenQueue();
    });
  }, [dismissActionsSheetAndWait, onOpenQueue, onClose]);

  const handleShare = useCallback(() => {
    onShare?.();
    onClose();
  }, [onShare, onClose]);

  // Only boards with an official app page get the row; the guard is what turns
  // the loose board string into the AuroraBoardName the builder assumes.
  const auroraBoardName = getBoardCapabilities(boardName).auroraAppLink ? toAuroraBoardName(boardName) : null;
  const auroraAppUrl = climb && auroraBoardName ? buildAuroraAppUrl(auroraBoardName, climb.uuid) : null;

  const handleOpenInApp = useCallback(async () => {
    if (!auroraAppUrl) return;
    try {
      track(SHARED_EVENTS.OpenInAuroraApp, { climbUuid: climb?.uuid ?? null, boardName, layoutId });
      await WebBrowser.openBrowserAsync(auroraAppUrl);
    } finally {
      onClose();
    }
  }, [auroraAppUrl, climb, boardName, onClose]);

  const handleCopyLink = useCallback(async () => {
    if (!climb) return;
    try {
      const url = `${CLIMB_SHARE_BASE_URL}${buildReadableClimbViewPath({
        boardName,
        layoutId,
        sizeId,
        setIds,
        angle,
        climbUuid: climb.uuid,
        climbName: climb.name,
      })}`;
      await Clipboard.setStringAsync(url);
      track(SHARED_EVENTS.ClimbShared, {
        method: 'copy_link',
        source: 'climb_actions_sheet',
        climbUuid: climb.uuid,
        boardName,
        layoutId,
      });
      showToast(t('mobile.climbActions.linkCopied'), 'info');
    } finally {
      onClose();
    }
  }, [climb, boardName, layoutId, sizeId, setIds, angle, onClose, showToast, t]);

  // The navigation hook claims the action before closing this sub-sheet, then awaits
  // the injected player transition when (and only when) this is the real `/play` route.
  const handleFork = useCallback(() => {
    if (!climb) return;
    openRemix(climb, { boardName, layoutId, sizeId, setIds, angle }, onClose);
  }, [climb, boardName, layoutId, sizeId, setIds, angle, openRemix, onClose]);

  const handleEdit = useCallback(() => {
    if (!climb) return;
    openEdit(climb, { boardName, layoutId, sizeId, setIds, angle }, onClose);
  }, [climb, boardName, layoutId, sizeId, setIds, angle, openEdit, onClose]);

  // Fork opens the create-climb editor with the climb's holds pre-painted, so it
  // is only offered where climbs can be set at all (not on Woods, and not on an
  // archived spray wall, which keeps its climbs but takes no new ones).
  const wallArchived = useSprayWallIsArchived(boardName, layoutId);
  const canFork = getBoardCapabilities(boardName).climbCreation && !wallArchived;

  // Who may edit is one shared rule (`canEditClimb`): the setter, a draft for
  // good and a published climb for 24 hours, on every board a spray wall
  // included. A hint only; the server decides.
  const canEdit = useMemo(() => {
    if (!getBoardCapabilities(boardName).climbCreation || wallArchived) return false;
    return canEditClimb({ climb, boardType: boardName, currentUserId });
  }, [climb, currentUserId, boardName, wallArchived]);

  // The setter's own published spray climb (#5960). The server decides whether
  // anybody has logged it.
  const canDelete = canDeleteClimb({ climb, boardName, currentUserId, wallArchived });
  const requestDeleteClimb = useDeleteClimbAction();
  const handleDelete = useCallback(() => {
    if (!climb) return;
    // Close this sheet first, so the confirm does not open over its dismiss.
    onClose();
    void requestDeleteClimb(climb, boardName, onClimbDeleted);
  }, [climb, boardName, onClose, requestDeleteClimb, onClimbDeleted]);

  // HIG Sheets: opens at medium with the climb preview and the first actions,
  // drags to large for the rest (owners and Aurora-app climbs get more rows);
  // the modal pans down to close.
  const snapPoints = MEDIUM_LARGE_SNAP_POINTS;
  // Monochrome on Liquid Glass, semantic on Material — resolved once as a token.
  const {
    success: successActionIconColor,
    favorite: favoriteActionIconColor,
    accent: accentActionIconColor,
  } = theme.actionColors;

  return (
    <ModalSheet
      ref={managedSheetRef}
      visible={visible && !!climb}
      snapPoints={snapPoints}
      onClose={onClose}
      enablePanDownToClose
    >
      {climb && (
        <ClimbPreviewCard
          climb={climb}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
        />
      )}
      <View style={styles.content}>
        {onAddToQueue && (
          <ListRow
            title={t('mobile.climbRow.addToQueue')}
            leading={<Icon name="add" size={22} color={successActionIconColor} />}
            onPress={handleAddToQueue}
            showSeparator
          />
        )}
        {onOpenQueue && (
          <ListRow
            title={t('mobile.climbActions.openQueue')}
            leading={<Icon name="queue" size={22} color={accentActionIconColor} />}
            onPress={handleOpenQueue}
            showSeparator
          />
        )}
        {onOpenPlaylist && (
          <ListRow
            title={t('actions.playlist.popover.title')}
            leading={<Icon name="playlist" size={22} color={accentActionIconColor} />}
            onPress={handleOpenPlaylist}
            showSeparator
          />
        )}
        {onToggleFavorite && (
          <ListRow
            title={t('mobile.climbRow.toggleFavorite')}
            leading={<Icon name="favorite" size={22} color={favoriteActionIconColor} />}
            onPress={handleToggleFavorite}
            showSeparator
          />
        )}
        {onTick && (
          <ListRow
            title={t('mobile.climbActions.tick')}
            leading={<Icon name="tick.fill" size={22} color={successActionIconColor} />}
            onPress={handleTick}
            showSeparator
          />
        )}
        {onEditEntry && (
          <ListRow
            title={t('mobile.climbActions.editEntry')}
            leading={<Icon name="edit" size={22} color={accentActionIconColor} />}
            onPress={handleEditEntry}
            showSeparator
          />
        )}
        {onAddBetaVideo && (
          <ListRow
            title={t('mobile.climbActions.addBetaVideo')}
            leading={<Icon name="video" size={22} color={accentActionIconColor} />}
            onPress={handleAddBetaVideo}
            showSeparator
          />
        )}
        {canEdit && (
          <ListRow
            title={t('mobile.climbActions.edit')}
            leading={<Icon name="edit" size={22} color={accentActionIconColor} />}
            onPress={handleEdit}
            showSeparator
          />
        )}
        {canFork && (
          <ListRow
            title={t('mobile.climbActions.fork')}
            leading={<Icon name="branch" size={22} color={accentActionIconColor} />}
            onPress={handleFork}
            showSeparator
          />
        )}
        {onShare && (
          <ListRow
            title={t('share.actionLabel')}
            leading={<Icon name="share" size={22} color={accentActionIconColor} />}
            onPress={handleShare}
            showSeparator
          />
        )}
        {climb?.is_draft !== true && (
          <ListRow
            title={t('mobile.climbActions.copyLink')}
            leading={<Icon name="copy" size={22} color={accentActionIconColor} />}
            onPress={handleCopyLink}
            showSeparator={!!auroraAppUrl || !!onReportClimb || canDelete}
          />
        )}
        {auroraAppUrl && (
          <ListRow
            title={t('mobile.climbActions.openInApp')}
            leading={<Icon name="open.external" size={22} color={accentActionIconColor} />}
            onPress={handleOpenInApp}
            showSeparator={!!onReportClimb || canDelete}
          />
        )}
        {/* Last row, and last for a reason: the one action that acts AGAINST the
            climb sits below everything a climber came here to do. */}
        {onReportClimb && (
          <ListRow
            title={
              // Your own spray climb: the report is how you change its grade (#5971).
              currentUserId && climb?.userId === currentUserId
                ? t('mobile.climbActions.changeGrade')
                : t('mobile.climbActions.report')
            }
            leading={<Icon name="flag" size={22} color={accentActionIconColor} />}
            onPress={handleReportClimb}
            showSeparator={canDelete}
          />
        )}
        {canDelete && (
          <ListRow
            title={t('mobile.climbActions.deleteClimb.row')}
            leading={<Icon name="delete" size={22} color={accentActionIconColor} />}
            onPress={handleDelete}
            showSeparator={false}
          />
        )}
      </View>
    </ModalSheet>
  );
}

export { ClimbActionsSheet };

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
});
