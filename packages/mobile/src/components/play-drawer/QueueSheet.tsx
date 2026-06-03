import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueList } from './QueueList';
import { SheetHandle } from '../SheetHandle';
import { Text } from '../Text';
import { useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticMedium, hapticWarning } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';

type QueueSheetProps = {
  visible: boolean;
  onClose: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
};

export function QueueSheet({ visible, onClose, onClimbPress }: QueueSheetProps) {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);

  const { state, removeFromQueue, clearQueue } = useQueue();
  const { queue, currentClimbQueueItem } = state;

  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const snapPoints = useMemo(() => ['60%', '90%'], []);

  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;

  useEffect(() => {
    if (visible) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [visible]);

  const resetState = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowFullHistory(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index < 0) {
        handleClose();
      }
    },
    [handleClose],
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

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const renderHandle = useCallback(() => <SheetHandle onClose={() => sheetRef.current?.close()} />, []);

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  const viewOnlyMode = queue.length === 0;

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onChange={handleSheetChange}
      onClose={handleClose}
      handleComponent={renderHandle}
      backgroundStyle={backgroundStyle}
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
        onClearAll={handleClearAll}
      />

      <QueueList
        queue={queue}
        currentItemUuid={currentItemUuid}
        isEditMode={isEditMode}
        showHistory={showHistory}
        showFullHistory={showFullHistory}
        selectedItems={selectedItems}
        autoScrollOnMount={visible}
        onToggleSelect={handleToggleSelect}
        onClimbPress={onClimbPress}
        onRemove={handleRemove}
        onShowFullHistory={handleShowFullHistory}
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
    </BottomSheet>
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
