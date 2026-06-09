import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueList } from './QueueList';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { Text } from '../Text';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { usePlaylistSuggestionSource, useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticMedium, hapticWarning } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// iOS renders the modal in a native window overlay so it sits above the
// persistent queue bar (mirrors ModalSheet / LogAscentSheet); Android's modal
// portal already covers it.
function ModalSheetContainer({ children }: { children?: ReactNode }) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? ModalSheetContainer : undefined;

type QueueSheetProps = {
  visible: boolean;
  board: QueueItemRowBoard;
  /** Request an animated close (header button) — host flips `visible` to false. */
  onClose: () => void;
  /** Fired AFTER the dismiss animation finishes so the host can unmount. */
  onDismissed: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
};

export function QueueSheet({
  visible,
  board,
  onClose,
  onDismissed,
  onClimbPress,
  onSuggestionPress,
  onTickHistory,
}: QueueSheetProps) {
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

  const snapPoints = useMemo(() => ['70%', '95%'], []);

  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const resetState = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowFullHistory(false);
  }, []);

  // The modal's dismiss animation has finished (header request, backdrop, or
  // pan-down). Reset local UI state and let the host unmount.
  const handleDismissed = useCallback(() => {
    resetState();
    onDismissed();
  }, [resetState, onDismissed]);

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

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={sheet.scrimOpacity}
        pressBehavior="close"
      />
    ),
    [sheet.scrimOpacity],
  );

  const viewOnlyMode = queue.length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // Stack above the play drawer (when opened from its queue button) instead
      // of replacing it, so closing the queue sheet reveals the drawer again.
      stackBehavior="push"
      enablePanDownToClose
      // Freeze the sheet pan while a row is being dragged so scroll-to-expand
      // never fights the reorder gesture.
      enableContentPanningGesture={!isDragging}
      enableHandlePanningGesture={!isDragging}
      backdropComponent={renderBackdrop}
      containerComponent={modalContainerComponent}
      onDismiss={handleDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundComponent={GlassSheetBackground}
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
        autoScrollOnMount={visible}
        onToggleSelect={handleToggleSelect}
        onClimbPress={onClimbPress}
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
}

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
