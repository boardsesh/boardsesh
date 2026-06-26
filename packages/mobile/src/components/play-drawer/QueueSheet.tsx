import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueList } from './QueueList';
import { Text } from '../Text';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { usePlaylistSuggestionSource, useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticMedium, hapticWarning } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type QueueSheetProps = {
  board: QueueItemRowBoard;
  /** Request an animated close (header button) — calls the imperative handle's
   *  `dismiss()` on the host side. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation finishes. The imperative model
   *  no longer needs this to unmount, so callers may omit it. */
  onDismissed?: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Long press a queue row → open the climb reaction menu. */
  onOpenActions?: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
};

/**
 * Imperative handle exposed to DrawerHostProvider. The sheet is opened by calling
 * `present()` synchronously from the tap handler (the same pattern PlayDrawer
 * uses) rather than driving it from a `visible`-prop effect.
 */
export type QueueSheetHandle = {
  present: () => void;
  dismiss: () => void;
};

export const QueueSheet = forwardRef<QueueSheetHandle, QueueSheetProps>(function QueueSheet(
  { board, onClose, onDismissed, onClimbPress, onOpenActions, onSuggestionPress, onTickHistory },
  ref,
) {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { systemColors, sheet } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);

  const { state, removeFromQueue, clearQueue, reorderQueue } = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const { queue, currentClimbQueueItem } = state;

  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  // Tracks whether the sheet is currently presented so the list only
  // auto-scrolls to the current item on a real open (not on background mounts).
  const [isPresented, setIsPresented] = useState(false);

  const snapPoints = useMemo(() => ['70%', '95%'], []);

  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;

  const resetState = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowFullHistory(false);
  }, []);

  // The modal's dismiss animation has actually SETTLED (coordinator: header
  // request, backdrop, or pan-down). Reset local UI state; the sheet stays
  // mounted (imperative model) and is re-presented on the next open.
  const handleFullyDismissed = useCallback(() => {
    setIsPresented(false);
    resetState();
    onDismissed?.();
  }, [resetState, onDismissed]);

  // Present/dismiss route through the coordinator so they never overlap another
  // sheet's transition (the iOS UIKit deadlock).
  const managed = useManagedSheet({ sheetRef, onFullyDismissed: handleFullyDismissed });

  useImperativeHandle(
    ref,
    () => ({
      present: () => {
        setIsPresented(true);
        managed.handle.present();
      },
      dismiss: () => {
        managed.handle.dismiss();
      },
    }),
    [managed.handle],
  );

  const handleToggleEditMode = useCallback(() => {
    setIsEditMode((prev) => {
      if (prev) {
        setSelectedItems(new Set());
      }
      return !prev;
    });
  }, []);

  const handleToggleHistory = useCallback(() => {
    setShowHistory((prev) => !prev);
  }, []);

  const handleShowFullHistory = useCallback(() => {
    setShowFullHistory(true);
  }, []);

  const handleToggleSelect = useCallback((uuid: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  const handleClearAll = useCallback(() => {
    hapticWarning();
    clearQueue();
    setIsEditMode(false);
    setSelectedItems(new Set());
  }, [clearQueue]);

  const handleBulkRemove = useCallback(() => {
    hapticMedium();
    for (const uuid of selectedItems) {
      removeFromQueue(uuid);
    }
    setSelectedItems(new Set());
    setIsEditMode(false);
  }, [selectedItems, removeFromQueue]);

  const handleRemove = useCallback(
    (uuid: string) => {
      removeFromQueue(uuid);
    },
    [removeFromQueue],
  );

  const viewOnlyMode = queue.length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      // Freeze the sheet pan while a row is being dragged so scroll-to-expand
      // never fights the reorder gesture.
      enableContentPanningGesture={!isDragging}
      enableHandlePanningGesture={!isDragging}
      onChange={managed.onChange}
      handleIndicatorStyle={sheet.handleStyle}
      style={styles.sheet}
    >
      <QueueSheetHeader
        isEditMode={isEditMode}
        showHistory={showHistory}
        selectedCount={selectedItems.size}
        queueCount={queue.length}
        viewOnlyMode={viewOnlyMode}
        onToggleEditMode={handleToggleEditMode}
        onToggleHistory={handleToggleHistory}
        onClose={onClose}
        onClearAll={handleClearAll}
      />

      <QueueList
        queue={queue}
        currentItemUuid={currentItemUuid}
        board={board}
        isEditMode={isEditMode}
        showHistory={showHistory}
        showFullHistory={showFullHistory}
        selectedItems={selectedItems}
        playlistSuggestionSource={playlistSuggestionSource}
        active={isPresented}
        autoScrollOnMount={isPresented}
        onToggleSelect={handleToggleSelect}
        onClimbPress={onClimbPress}
        onOpenActions={onOpenActions}
        onRemove={handleRemove}
        onShowFullHistory={handleShowFullHistory}
        onTickHistory={onTickHistory}
        onSuggestionPress={onSuggestionPress}
        reorderQueue={reorderQueue}
        onDraggingChange={setIsDragging}
      />

      {isEditMode && selectedItems.size > 0 && (
        <View
          style={[
            styles.bulkBar,
            {
              paddingBottom: insets.bottom + spacing[3],
              backgroundColor: systemColors.background,
              borderTopColor: systemColors.separator,
            },
          ]}
        >
          <Pressable
            onPress={handleBulkRemove}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.removeItems', { count: selectedItems.size })}
            style={styles.bulkButton}
          >
            <Text variant="headline" color={iosSystemColors.white}>
              {t('queueDrawer.removeItems', { count: selectedItems.size })}
            </Text>
          </Pressable>
        </View>
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  sheet: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  bulkBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bulkButton: {
    backgroundColor: brandColors.error,
    borderRadius: 12,
    paddingVertical: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
