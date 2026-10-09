import { memo, useCallback, useMemo, type ComponentType } from 'react';
import { StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { SwitchRow } from '../SwitchRow';
import { Button } from '../Button';
import { Text } from '../Text';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import {
  usePlayDrawerSectionControls,
  type PlayDrawerSectionControl,
} from '../settings/use-play-drawer-section-controls';
import { PLAY_DRAWER_SECTION_IDS, type PlayDrawerSectionId } from '../../lib/play-drawer-sections-preference';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<PlayDrawerSectionControl>>;
const LAST_SECTION_INDEX = PLAY_DRAWER_SECTION_IDS.length - 1;
function keyExtractor(control: PlayDrawerSectionControl): string {
  return control.id;
}
const SectionRow = memo(function SectionRow({
  id,
  label,
  enabled,
  ready,
  first,
  last,
  onSectionChange,
}: PlayDrawerSectionControl & {
  ready: boolean;
  first: boolean;
  last: boolean;
  onSectionChange: (id: PlayDrawerSectionId, enabled: boolean) => void;
}) {
  const { systemColors } = useTheme();
  const onValueChange = useCallback((next: boolean) => onSectionChange(id, next), [id, onSectionChange]);
  return (
    <View
      style={[
        styles.sectionRow,
        { backgroundColor: systemColors.secondaryBackground },
        first && styles.firstRow,
        last && styles.lastRow,
      ]}
    >
      <SwitchRow label={label} value={enabled} onValueChange={onValueChange} disabled={!ready} />
      {!last ? <View style={[styles.separator, { backgroundColor: systemColors.separator }]} /> : null}
    </View>
  );
});

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
    hideAllLabel,
    showAllLabel,
    hideAll,
    showAll,
    canHideAll,
    canShowAll,
  } = usePlayDrawerSectionControls();
  const { systemColors } = useTheme();
  const renderItem = useCallback(
    ({ item, index }: { item: PlayDrawerSectionControl; index: number }) => (
      <SectionRow
        {...item}
        ready={ready}
        first={index === 0}
        last={index === LAST_SECTION_INDEX}
        onSectionChange={onSectionChange}
      />
    ),
    [ready, onSectionChange],
  );
  const listFooter = useMemo(
    () => (
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.guidance}>
        {footer}
      </Text>
    ),
    [footer, systemColors.secondaryLabel],
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
          <View style={[styles.headerControls, { backgroundColor: systemColors.groupedBackground }]}>
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
      <SheetFlatList
        style={[styles.list, { backgroundColor: systemColors.groupedBackground }]}
        contentContainerStyle={styles.listContent}
        data={controls}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListFooterComponent={listFooter}
        showsVerticalScrollIndicator={false}
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
  sectionRow: { overflow: 'hidden' },
  firstRow: { borderTopLeftRadius: borderRadius.lg, borderTopRightRadius: borderRadius.lg },
  lastRow: { borderBottomLeftRadius: borderRadius.lg, borderBottomRightRadius: borderRadius.lg },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: spacing[4] },
  guidance: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
});
