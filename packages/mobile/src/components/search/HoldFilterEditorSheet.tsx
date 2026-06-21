import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getLayout } from '@boardsesh/board-constants/product-sizes';
import { countFilteredHolds, toggleHoldFilterType, type BoardSearchConfig } from '@boardsesh/climb-filters';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { InteractiveFilterBoard } from './InteractiveFilterBoard';
import { HoldFilterPicker } from './HoldFilterPicker';
import { useTheme } from '../../providers/theme-provider';
import { getCreateBoardHolds, parseSetIdsParam } from '../../lib/create-board-holds';
import { track } from '../../lib/analytics';
import { spacing } from '../../theme/tokens';

type HoldFilterEditorSheetProps = {
  visible: boolean;
  boardConfig: BoardSearchConfig;
  holdsFilter: HoldsFilter;
  onHoldsFilterChange: (holdsFilter: HoldsFilter) => void;
  onClose: () => void;
  onDismiss: () => void;
};

const SHEET_HEIGHT_RATIO = 0.95;
// Header + the below-board hold-type controls (toggle + chip row + clear/hint)
// + safe area, so the board is sized to leave the controls fully on-screen.
const CHROME_BUDGET = 320;
const DEFER_BOARD_RENDER_MS = 120;

export function HoldFilterEditorSheet({
  visible,
  boardConfig,
  holdsFilter,
  onHoldsFilterChange,
  onClose,
  onDismiss,
}: HoldFilterEditorSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const boardName = boardConfig.boardName as BoardName;
  const boardLayout = getLayout(boardName, boardConfig.layoutId)?.name ?? '';
  const [selectedType, setSelectedType] = useState<HoldFilterType>('HAND');
  const [applyMode, setApplyMode] = useState<HoldFilterMode>('include');
  const [contentReady, setContentReady] = useState(false);

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
      const timeout = setTimeout(() => setContentReady(true), DEFER_BOARD_RENDER_MS);
      return () => clearTimeout(timeout);
    } else {
      setContentReady(false);
      sheetRef.current?.dismiss();
    }
    return undefined;
  }, [visible]);

  const boardHolds = useMemo(() => {
    if (!contentReady) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: parseSetIdsParam(boardConfig.setIds),
    });
  }, [contentReady, boardName, boardConfig.layoutId, boardConfig.sizeId, boardConfig.setIds]);

  const boardRender = useMemo(() => {
    if (!boardHolds) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = windowWidth - spacing[4] * 2;
    const sheetHeight = windowHeight * SHEET_HEIGHT_RATIO;
    const availHeight = Math.max(200, sheetHeight - insets.bottom - CHROME_BUDGET);
    if (availWidth / availHeight > boardAspect) {
      return { width: availHeight * boardAspect, height: availHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds, windowWidth, windowHeight, insets.bottom]);

  // Paint the selected brush (type + include/exclude) onto the tapped hold:
  // toggle that type at the current mode, dropping the hold if it ends up empty.
  const handleHoldTap = useCallback(
    (holdId: number) => {
      const holdKey = String(holdId);
      const existing: HoldFilterEntry = holdsFilter[holdKey] ?? {};
      const nextEntry = toggleHoldFilterType(existing, selectedType, applyMode);
      const next: HoldsFilter = { ...holdsFilter };
      if (Object.keys(nextEntry).length === 0) {
        delete next[holdKey];
      } else {
        next[holdKey] = nextEntry;
      }
      onHoldsFilterChange(next);
      track(SHARED_EVENTS.SearchHoldFilterChanged, {
        type: selectedType,
        mode: applyMode,
        boardLayout,
      });
    },
    [selectedType, applyMode, boardLayout, holdsFilter, onHoldsFilterChange],
  );

  const handleClearAll = useCallback(() => {
    onHoldsFilterChange({});
    track(SHARED_EVENTS.SearchHoldFilterCleared, { boardLayout });
  }, [boardLayout, onHoldsFilterChange]);

  const filteredCount = countFilteredHolds(holdsFilter);

  return (
    <ModalSheet ref={sheetRef} snapPoints={['95%']} onDismiss={onDismiss} stackBehavior="push">
      <View style={styles.container}>
        {!boardHolds ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          <>
            <View style={styles.header}>
              <Text variant="title3">{t('mobile.holdFilter.title')}</Text>
              <View style={styles.headerActions}>
                {filteredCount > 0 ? (
                  <Pressable onPress={handleClearAll} hitSlop={8} accessibilityRole="button">
                    <Text variant="subheadline" color={brandColors.primary}>
                      {t('mobile.filter.clearAll')}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
                  <Text variant="subheadline" color={brandColors.primary} style={styles.doneLabel}>
                    {t('mobile.filter.done')}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.boardSection}>
              <InteractiveFilterBoard
                boardName={boardName}
                layoutId={boardConfig.layoutId}
                sizeId={boardConfig.sizeId}
                setIds={boardConfig.setIds}
                boardWidth={boardHolds.boardWidth}
                boardHeight={boardHolds.boardHeight}
                holdTargets={boardHolds.holdTargets}
                holdsFilter={holdsFilter}
                onHoldTap={handleHoldTap}
                showHoldMarkers={false}
                renderWidth={boardRender.width}
                renderHeight={boardRender.height}
              />
            </View>

            {/* Hold-type brush selector docked below the board (create-climb-style
                action bar): pick a type + include/exclude, then tap holds to paint
                them. Inline — not a stacked sub-sheet — so it reliably shows. */}
            <HoldFilterPicker
              boardName={boardName}
              selectedType={selectedType}
              onSelectType={setSelectedType}
              applyMode={applyMode}
              onApplyModeChange={setApplyMode}
            />
          </>
        )}
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  doneLabel: {
    fontWeight: '600',
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
