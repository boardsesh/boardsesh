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
import type { PlayDrawerSectionId } from '../../lib/play-drawer-sections-preference';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<PlayDrawerSectionControl>>;
function keyExtractor(control: PlayDrawerSectionControl): string {
  return control.id;
}
const SectionRow = memo(function SectionRow({
  id,
  label,
  enabled,
  ready,
  onSectionChange,
}: PlayDrawerSectionControl & {
  ready: boolean;
  onSectionChange: (id: PlayDrawerSectionId, enabled: boolean) => void;
}) {
  const onValueChange = useCallback((next: boolean) => onSectionChange(id, next), [id, onSectionChange]);
  return <SwitchRow label={label} value={enabled} onValueChange={onValueChange} disabled={!ready} />;
});

/** Keep mounted inside PlayDrawer so its managed presenter sits above /play. */
export function PlayDrawerSectionsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { title, description, ready, controls, onSectionChange, hideAllLabel, showAllLabel, hideAll, showAll } =
    usePlayDrawerSectionControls();
  const { systemColors } = useTheme();
  const renderItem = useCallback(
    ({ item }: { item: PlayDrawerSectionControl }) => (
      <SectionRow {...item} ready={ready} onSectionChange={onSectionChange} />
    ),
    [ready, onSectionChange],
  );
  const listHeader = useMemo(
    () => (
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
        {description}
      </Text>
    ),
    [description, systemColors.secondaryLabel],
  );
  const listFooter = useMemo(
    () => (
      <View style={styles.actions}>
        <Button title={hideAllLabel} onPress={hideAll} disabled={!ready} haptic={false} variant="outlined" />
        <Button title={showAllLabel} onPress={showAll} disabled={!ready} haptic={false} variant="outlined" />
      </View>
    ),
    [hideAllLabel, showAllLabel, hideAll, showAll, ready],
  );
  return (
    <ModalSheet
      visible={visible}
      onClose={onClose}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable={false}
      surface="solid"
      header={<SheetTopBar title={title} leading={{ kind: 'close', onPress: onClose }} />}
    >
      <SheetFlatList
        data={controls}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        showsVerticalScrollIndicator={false}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  description: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  actions: { paddingHorizontal: spacing[4], paddingVertical: spacing[3], gap: spacing[3] },
});
