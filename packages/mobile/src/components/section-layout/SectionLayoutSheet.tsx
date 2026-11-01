import { memo, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type FlatListProps, type ViewStyle } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Button } from '../Button';
import { Text } from '../Text';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import {
  SectionLayoutList,
  type PlacedSectionLayoutRow,
  type SectionLayoutRowModel,
  type SectionMoveHandler,
} from './SectionLayoutList';

// The pieces of a sheet that shows, hides and orders a surface's sections: the
// climb's View options (both its tabs) and Customize Home. A sheet composes them:
//
//   <SectionLayoutSheetFrame title={…} header={<SectionLayoutSheetIntro … />}>
//     <SectionLayoutSheetList rows={…} ListFooterComponent={<SectionLayoutSheetFooter … />} />
//   </SectionLayoutSheetFrame>
//
// Choices apply at once; the close button only dismisses.

/**
 * The ground behind the header controls and the list. Left unset on Apple's
 * native sheet so its material shows; only the inset switch group needs an
 * opaque surface there. Material, Reduce Transparency, Android and web keep the
 * grouped background.
 */
function useSectionLayoutSheetGround(): ViewStyle | undefined {
  const { systemColors } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  return Platform.OS === 'ios' && iosBackgroundStyle === undefined
    ? undefined
    : { backgroundColor: systemColors.groupedBackground };
}

/**
 * The managed `ModalSheet` with its top bar, the pinned header controls and one
 * list. Mount it inside the surface whose presenter it should sit above.
 */
export function SectionLayoutSheetFrame({
  visible,
  onClose,
  title,
  header,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  /**
   * What stays pinned above the list, such as tabs. Leave it out to pin
   * nothing, and put `SectionLayoutSheetIntro` in the list's header instead, so
   * it scrolls away at large text on a small phone.
   */
  header?: ReactNode;
  /** One `SectionLayoutSheetList`. */
  children: ReactNode;
}) {
  const ground = useSectionLayoutSheetGround();
  return (
    <ModalSheet
      visible={visible}
      onClose={onClose}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable={false}
      surface="solid"
      header={
        <View>
          <SheetTopBar title={title} leading={{ kind: 'close', onPress: onClose }} />
          {header ? <View style={[styles.headerControls, ground]}>{header}</View> : null}
        </View>
      }
    >
      {children}
    </ModalSheet>
  );
}

/** A text button in the sheet: one of the pair above the list, or Restore defaults under it. */
export type SectionLayoutSheetAction = {
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
};

/**
 * What the sheet changes, two equal text buttons side by side (Show all and
 * Hide all, or Show all and Focused) and an optional heading over the switches.
 * A fragment, so it sits straight in the frame's header controls.
 */
export const SectionLayoutSheetIntro = memo(function SectionLayoutSheetIntro({
  description,
  actions,
  groupTitle,
}: {
  description: string;
  actions: readonly [SectionLayoutSheetAction, SectionLayoutSheetAction];
  groupTitle?: string;
}) {
  const { systemColors } = useTheme();
  return (
    <>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {description}
      </Text>
      <View style={styles.actions}>
        {actions.map((action) => (
          <View key={action.testID} style={styles.actionSlot}>
            <Button
              title={action.label}
              onPress={action.onPress}
              disabled={action.disabled}
              haptic={false}
              variant="text"
              style={styles.actionButton}
              minHeight={44}
              testID={action.testID}
            />
          </View>
        ))}
      </View>
      {groupTitle ? <SectionLayoutSheetGroupTitle title={groupTitle} /> : null}
    </>
  );
});

/** A heading over a group of rows, like "Below the climb". */
export function SectionLayoutSheetGroupTitle({ title }: { title: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.groupTitle} accessibilityRole="header">
      {title}
    </Text>
  );
}

/** Guidance under the list, then Restore defaults lined up with it. */
export const SectionLayoutSheetFooter = memo(function SectionLayoutSheetFooter({
  guidance,
  restoreDefaults,
}: {
  guidance: string;
  restoreDefaults: SectionLayoutSheetAction;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.footer}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={sectionLayoutSheetStyles.guidance}>
        {guidance}
      </Text>
      <View style={styles.restoreDefaults}>
        <Button
          title={restoreDefaults.label}
          onPress={restoreDefaults.onPress}
          disabled={restoreDefaults.disabled}
          haptic={false}
          variant="text"
          minHeight={44}
          testID={restoreDefaults.testID}
        />
      </View>
    </View>
  );
});

type SectionLayoutSheetListProps<Id extends string> = {
  rows: readonly SectionLayoutRowModel<Id>[];
  /** Greys every switch and arrow out, such as while a stored layout still loads. */
  disabled?: boolean;
  onVisibleChange: (sectionId: Id, visible: boolean) => void;
  onMove: SectionMoveHandler<Id>;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
};

/** `SectionLayoutList` in the sheet's own scroll list, on the sheet's ground. */
function SectionLayoutSheetListBase<Id extends string>({
  rows,
  disabled,
  onVisibleChange,
  onMove,
  ListHeaderComponent,
  ListFooterComponent,
}: SectionLayoutSheetListProps<Id>) {
  const ground = useSectionLayoutSheetGround();
  const ListComponent = BottomSheetFlatList as ComponentType<FlatListProps<PlacedSectionLayoutRow<Id>>>;
  return (
    <SectionLayoutList
      ListComponent={ListComponent}
      style={[styles.list, ground]}
      contentContainerStyle={styles.listContent}
      rows={rows}
      disabled={disabled}
      onVisibleChange={onVisibleChange}
      onMove={onMove}
      ListHeaderComponent={ListHeaderComponent ?? undefined}
      ListFooterComponent={ListFooterComponent ?? undefined}
    />
  );
}

export const SectionLayoutSheetList = memo(SectionLayoutSheetListBase) as typeof SectionLayoutSheetListBase;

/** Spacing a sheet's own header or footer content shares with these pieces. */
export const sectionLayoutSheetStyles = StyleSheet.create({
  guidance: { paddingHorizontal: spacing[4] },
  /** `SectionLayoutSheetIntro` as the list's header, spaced like the pinned header controls. */
  listIntro: { paddingTop: spacing[3], paddingBottom: spacing[3], gap: spacing[2] },
});

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing[4] },
  headerControls: { paddingHorizontal: spacing[4], paddingTop: spacing[3], paddingBottom: spacing[2], gap: spacing[2] },
  actions: { flexDirection: 'row', gap: spacing[2] },
  actionSlot: { flex: 1 },
  actionButton: { width: '100%' },
  groupTitle: { paddingHorizontal: spacing[4], fontWeight: '600' },
  footer: { paddingVertical: spacing[3], gap: spacing[2] },
  // Lines the action up with the guidance above it.
  restoreDefaults: { paddingHorizontal: spacing[4] },
});
