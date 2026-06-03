import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import type { Climb } from '@boardsesh/shared-schema';
import { buildClimbViewPath } from '@boardsesh/play-view';
import { computeCanUpdate, type SavedClimbSnapshot } from '@boardsesh/create-climb-react';
import { Sheet } from './Sheet';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { useToast } from '../providers/toast-provider';
import { brandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { WEB_BASE_URL } from '../lib/env';

type ClimbActionsSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: string;
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
  const router = useRouter();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (visible && climb) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
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
      await WebBrowser.openBrowserAsync(auroraAppUrl);
    } finally {
      onClose();
    }
  }, [auroraAppUrl, onClose]);

  const handleCopyLink = useCallback(async () => {
    if (!climb) return;
    try {
      const url = `${WEB_BASE_URL}${buildClimbViewPath(boardName, layoutId, sizeId, setIds, angle, climb.uuid)}`;
      await Clipboard.setStringAsync(url);
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

  const handleClose = useCallback(() => {
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
  // MoonBoard is create-only on mobile (no in-place update path), so it never
  // offers an Edit row.
  const canEdit = useMemo(() => {
    if (boardName === 'moonboard') return false;
    if (!climb || !currentUserId || !climb.userId || climb.userId !== currentUserId) return false;
    const snapshot: SavedClimbSnapshot = {
      uuid: climb.uuid,
      boardType: boardName,
      createdAt: climb.created_at ?? null,
      publishedAt: climb.published_at ?? null,
      isDraft: climb.is_draft ?? false,
    };
    return (climb.is_draft ?? false) || computeCanUpdate(snapshot, boardName);
  }, [climb, currentUserId, boardName]);

  const snapPoints = useMemo(() => ['40%'], []);

  return (
    <Sheet ref={sheetRef} snapPoints={snapPoints} onClose={handleClose} enablePanDownToClose>
      <View style={styles.content}>
        {onAddToQueue && (
          <ListRow
            title={t('mobile.climbRow.addToQueue')}
            leading={<Icon name="add" size={22} color={brandColors.success} />}
            onPress={handleAddToQueue}
            showSeparator
          />
        )}
        {onToggleFavorite && (
          <ListRow
            title={t('mobile.climbRow.toggleFavorite')}
            leading={<Icon name="favorite" size={22} color={iosSystemColors.systemRed} />}
            onPress={handleToggleFavorite}
            showSeparator
          />
        )}
        {onTick && (
          <ListRow
            title={t('mobile.climbActions.tick')}
            leading={<Icon name="tick" size={22} color={brandColors.success} />}
            onPress={handleTick}
            showSeparator
          />
        )}
        {canEdit && (
          <ListRow
            title={t('mobile.climbActions.edit')}
            leading={<Icon name="edit" size={22} color={iosSystemColors.systemBlue} />}
            onPress={handleEdit}
            showSeparator
          />
        )}
        <ListRow
          title={t('mobile.climbActions.fork')}
          leading={<Icon name="branch" size={22} color={iosSystemColors.systemBlue} />}
          onPress={handleFork}
          showSeparator
        />
        <ListRow
          title={t('mobile.climbActions.copyLink')}
          leading={<Icon name="copy" size={22} color={iosSystemColors.systemBlue} />}
          onPress={handleCopyLink}
          showSeparator
        />
        <ListRow
          title={t('mobile.climbActions.report')}
          leading={<Icon name="flag" size={22} color={iosSystemColors.systemOrange} />}
          onPress={handleReport}
          showSeparator={!!auroraAppUrl}
        />
        {auroraAppUrl && (
          <ListRow
            title={t('mobile.climbActions.openInApp')}
            leading={<Icon name="open.external" size={22} color={iosSystemColors.systemBlue} />}
            onPress={handleOpenInApp}
            showSeparator={false}
          />
        )}
      </View>
    </Sheet>
  );
}

export { ClimbActionsSheet };

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
});
