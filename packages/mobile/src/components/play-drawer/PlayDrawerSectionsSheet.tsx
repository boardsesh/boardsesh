import { useMemo, type ComponentType } from 'react';
import { Platform, StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Button } from '../Button';
import { Text } from '../Text';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
import { usePlayDrawerSectionControls } from '../settings/use-play-drawer-section-controls';
import { SectionLayoutList, type PlacedSectionLayoutRow } from '../section-layout/SectionLayoutList';
import type { PlayDrawerSectionId } from '../../lib/play-drawer-sections-preference';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<PlacedSectionLayoutRow<PlayDrawerSectionId>>>;

/** Keep mounted inside PlayDrawer so its managed presenter sits above /play. */
export function PlayDrawerSectionsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const {
    sheetTitle,
    description,
    groupTitle,
    footer,
    ready,
    controls,
    onSectionChange,
    onMove,
    hideAllLabel,
    showAllLabel,
    restoreDefaultsLabel,
    hideAll,
    showAll,
    restoreDefaults,
    canHideAll,
    canShowAll,
    canRestoreDefaults,
  } = usePlayDrawerSectionControls();
  const { systemColors } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  // Leave the surrounding sheet material visible on Apple's native sheet.
  // Only the inset switch group needs its semantic opaque content surface.
  const contentGround =
    Platform.OS === 'ios' && iosBackgroundStyle === undefined
      ? undefined
      : { backgroundColor: systemColors.groupedBackground };
  const listFooter = useMemo(
    () => (
      <View style={styles.footer}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.guidance}>
          {footer}
        </Text>
        <View style={styles.restoreDefaults}>
          <Button
            title={restoreDefaultsLabel}
            onPress={restoreDefaults}
            disabled={!canRestoreDefaults}
            haptic={false}
            variant="text"
            minHeight={44}
            testID="play-drawer-sections-restore-defaults"
          />
        </View>
      </View>
    ),
    [footer, systemColors.secondaryLabel, restoreDefaultsLabel, restoreDefaults, canRestoreDefaults],
  );
  return (
    <ModalSheet
      visible={visible}
      onClose={onClose}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable={false}
      surface="solid"
      header={
        <View>
          <SheetTopBar title={sheetTitle} leading={{ kind: 'close', onPress: onClose }} />
          <View style={[styles.headerControls, contentGround]}>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {description}
            </Text>
            <View style={styles.actions}>
              <View style={styles.actionSlot}>
                <Button
                  title={showAllLabel}
                  onPress={showAll}
                  disabled={!canShowAll}
                  haptic={false}
                  variant="text"
                  style={styles.actionButton}
                  minHeight={44}
                  testID="play-drawer-sections-show-all"
                />
              </View>
              <View style={styles.actionSlot}>
                <Button
                  title={hideAllLabel}
                  onPress={hideAll}
                  disabled={!canHideAll}
                  haptic={false}
                  variant="text"
                  style={styles.actionButton}
                  minHeight={44}
                  testID="play-drawer-sections-hide-all"
                />
              </View>
            </View>
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              style={styles.groupTitle}
              accessibilityRole="header"
            >
              {groupTitle}
            </Text>
          </View>
        </View>
      }
    >
      <SectionLayoutList
        ListComponent={SheetFlatList}
        style={[styles.list, contentGround]}
        contentContainerStyle={styles.listContent}
        rows={controls}
        disabled={!ready}
        onVisibleChange={onSectionChange}
        onMove={onMove}
        ListFooterComponent={listFooter}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing[4] },
  headerControls: { paddingHorizontal: spacing[4], paddingTop: spacing[3], paddingBottom: spacing[2], gap: spacing[2] },
  actions: { flexDirection: 'row', gap: spacing[2] },
  actionSlot: { flex: 1 },
  actionButton: { width: '100%' },
  groupTitle: { paddingHorizontal: spacing[4], fontWeight: '600' },
  footer: { paddingVertical: spacing[3], gap: spacing[2] },
  guidance: { paddingHorizontal: spacing[4] },
  // Lines the action up with the guidance above it.
  restoreDefaults: { paddingHorizontal: spacing[4] },
});
