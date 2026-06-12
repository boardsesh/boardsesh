import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { buildClimbViewPath } from '@boardsesh/play-view';
import { computeCanUpdate, type SavedClimbSnapshot } from '@boardsesh/create-climb-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ModalSheet } from './ModalSheet';
import { ClimbPreviewCard } from './ClimbPreviewCard';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { useToast } from '../providers/toast-provider';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { WEB_BASE_URL } from '../lib/env';
import { track } from '../lib/analytics';

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
  onToggleFavorite?: () => void;
  /** When provided, shows a "Log a tick" row that opens the LogAscent sheet. */
  onTick?: () => void;
  onClose: () => void;
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
function buildAuroraAppUrl(boardName: string, climbUuid: string): string | null {
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
  onToggleFavorite,
  onTick,
  onClose,
}: ClimbActionsSheetProps) {
  const { t } = useTranslation('climbs');
  const { showToast } = useToast();
  const theme = useTheme();
  const router = useRouter();
  const sheetRef = useRef<BottomSheetModal>(null);
  // Track presented state so we never dismiss() a not-presented modal (which
  // leaves gorhom unable to present() again — the "nothing happens" bug).
  // Presenting on a real `visible` transition is also what lets this sheet stack
  // reliably above the Play Drawer's own modal. Mirrors LogAscentSheet.
  const isPresentedRef = useRef(false);

  useEffect(() => {
    if (visible && climb && !isPresentedRef.current) {
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if ((!visible || !climb) && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible, climb]);

  const handleAddToQueue = useCallback(() => {
    onAddToQueue?.();
    onClose();
  }, [onAddToQueue, onClose]);

  const handleToggleFavorite = useCallback(() => {
    onToggleFavorite?.();
    onClose();
  }, [onToggleFavorite, onClose]);

  const handleTick = useCallback(() => {
    onTick?.();
    onClose();
  }, [onTick, onClose]);

  const auroraAppUrl = climb ? buildAuroraAppUrl(boardName, climb.uuid) : null;

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
      const url = `${WEB_BASE_URL}${buildClimbViewPath(boardName, layoutId, sizeId, setIds, angle, climb.uuid)}`;
      await Clipboard.setStringAsync(url);
      track(SHARED_EVENTS.ClimbShared, { method: 'copy_link', climbUuid: climb.uuid, boardName, layoutId });
      showToast(t('mobile.climbActions.linkCopied'), 'info');
    } finally {
      onClose();
    }
  }, [climb, boardName, layoutId, sizeId, setIds, angle, onClose, showToast, t]);

  const handleReport = useCallback(async () => {
    if (!climb) return;
    try {
      const reportUrl = `${WEB_BASE_URL}${buildClimbViewPath(boardName, layoutId, sizeId, setIds, angle, climb.uuid)}?report=true`;
      await WebBrowser.openBrowserAsync(reportUrl);
    } finally {
      onClose();
    }
  }, [climb, boardName, layoutId, sizeId, setIds, angle, onClose]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleFork = useCallback(() => {
    if (!climb) return;
    onClose();
    router.push({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: climb.frames,
        forkName: climb.name,
        forkDescription: climb.description ?? '',
        boardName,
        layoutId: String(layoutId),
        sizeId: String(sizeId),
        setIds,
        angle: String(angle),
      },
    });
  }, [climb, boardName, layoutId, sizeId, setIds, angle, router, onClose]);

  const handleEdit = useCallback(() => {
    if (!climb) return;
    onClose();
    router.push({
      pathname: '/(tabs)/climbs/create',
      params: {
        editClimbUuid: climb.uuid,
        boardName,
        layoutId: String(layoutId),
        sizeId: String(sizeId),
        setIds,
        angle: String(angle),
      },
    });
  }, [climb, boardName, layoutId, sizeId, setIds, angle, router, onClose]);

  // Edit is owner-only, and only while the climb is still a draft OR within
  // 24h of first publish (the backend enforces the same window). `userId`
  // is null for Aurora-synced climbs that predate Boardsesh accounts.
  const canEdit = useMemo(() => {
    if (!climb || !currentUserId || !climb.userId || climb.userId !== currentUserId) return false;
    const snapshot: SavedClimbSnapshot = {
      uuid: climb.uuid,
      boardType: boardName,
      createdAt: climb.created_at ?? null,
      publishedAt: climb.published_at ?? null,
      isDraft: climb.is_draft ?? false,
    };
    // `computeCanUpdate` already returns true for drafts, so no separate
    // is_draft guard is needed — keep the draft rule in one place.
    return computeCanUpdate(snapshot, boardName);
  }, [climb, currentUserId, boardName]);

  // Sized for the climb preview row plus the action list (a couple more rows show
  // for owners / Aurora-app climbs); the modal pans down to close.
  const snapPoints = useMemo(() => ['55%'], []);
  const neutralActionIconColor = theme.systemColors.label;
  const successActionIconColor = theme.variant === 'liquidGlass' ? neutralActionIconColor : theme.brandColors.success;
  const favoriteActionIconColor = theme.variant === 'liquidGlass' ? neutralActionIconColor : iosSystemColors.systemRed;
  const accentActionIconColor = theme.variant === 'liquidGlass' ? neutralActionIconColor : theme.systemColors.accent;
  const reportActionIconColor = iosSystemColors.systemOrange;

  return (
    <ModalSheet ref={sheetRef} snapPoints={snapPoints} onDismiss={handleDismiss} enablePanDownToClose>
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
            leading={<Icon name="tick" size={22} color={successActionIconColor} />}
            onPress={handleTick}
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
        <ListRow
          title={t('mobile.climbActions.fork')}
          leading={<Icon name="branch" size={22} color={accentActionIconColor} />}
          onPress={handleFork}
          showSeparator
        />
        <ListRow
          title={t('mobile.climbActions.copyLink')}
          leading={<Icon name="copy" size={22} color={accentActionIconColor} />}
          onPress={handleCopyLink}
          showSeparator
        />
        <ListRow
          title={t('mobile.climbActions.report')}
          leading={<Icon name="flag" size={22} color={reportActionIconColor} />}
          onPress={handleReport}
          showSeparator={!!auroraAppUrl}
        />
        {auroraAppUrl && (
          <ListRow
            title={t('mobile.climbActions.openInApp')}
            leading={<Icon name="open.external" size={22} color={accentActionIconColor} />}
            onPress={handleOpenInApp}
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
