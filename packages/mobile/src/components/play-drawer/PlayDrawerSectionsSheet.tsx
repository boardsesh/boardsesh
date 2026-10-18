import { useMemo, useState, type ComponentType } from 'react';
import { Platform, StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { SegmentedControl } from '../SegmentedControl';
import { SwitchRow } from '../SwitchRow';
import { Button } from '../Button';
import { Text } from '../Text';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
import { usePlayDrawerSectionControls } from '../settings/use-play-drawer-section-controls';
import { usePlayerButtonControls } from '../settings/use-player-button-controls';
import { SectionLayoutList, type PlacedSectionLayoutRow } from '../section-layout/SectionLayoutList';
import { PlayerButtonsPreview, type PlayerButtonsPreviewBoard } from '../player-buttons/PlayerButtonsPreview';
import type { PlayDrawerSectionId } from '../../lib/play-drawer-sections-preference';
import type { PlayerButtonId } from '../../lib/player-buttons';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

const SectionsFlatList = BottomSheetFlatList as ComponentType<
  FlatListProps<PlacedSectionLayoutRow<PlayDrawerSectionId>>
>;
const ButtonsFlatList = BottomSheetFlatList as ComponentType<FlatListProps<PlacedSectionLayoutRow<PlayerButtonId>>>;

type ViewOptionsTab = 'sections' | 'buttons';

type PlayDrawerSectionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The board on screen, so the buttons preview draws the bar this climber will see. */
  previewBoard: PlayerButtonsPreviewBoard;
};

/**
 * ⋯ → View options. Two tabs: the sections below the climb, and the player's
 * buttons (#6229). Choices apply at once; there is no save step. Keep mounted
 * inside PlayDrawer so its managed presenter sits above /play.
 */
export function PlayDrawerSectionsSheet({ visible, onClose, previewBoard }: PlayDrawerSectionsSheetProps) {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<ViewOptionsTab>('sections');
  const sections = usePlayDrawerSectionControls();
  const playerButtons = usePlayerButtonControls();
  const { systemColors } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  // Leave the surrounding sheet material visible on Apple's native sheet.
  // Only the inset switch group needs its semantic opaque content surface.
  const contentGround =
    Platform.OS === 'ios' && iosBackgroundStyle === undefined
      ? undefined
      : { backgroundColor: systemColors.groupedBackground };
  const tabOptions = useMemo<{ key: ViewOptionsTab; label: string }[]>(
    () => [
      { key: 'sections', label: t('mobile.settings.climbDrawer.tabs.sections') },
      { key: 'buttons', label: t('mobile.settings.climbDrawer.tabs.buttons') },
    ],
    [t],
  );

  const sectionsFooter = useMemo(
    () => (
      <View style={styles.footer}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.guidance}>
          {sections.footer}
        </Text>
        <View style={styles.restoreDefaults}>
          <Button
            title={sections.restoreDefaultsLabel}
            onPress={sections.restoreDefaults}
            disabled={!sections.canRestoreDefaults}
            haptic={false}
            variant="text"
            minHeight={44}
            testID="play-drawer-sections-restore-defaults"
          />
        </View>
      </View>
    ),
    [
      sections.footer,
      systemColors.secondaryLabel,
      sections.restoreDefaultsLabel,
      sections.restoreDefaults,
      sections.canRestoreDefaults,
    ],
  );

  // The position and Previous and next scroll with the list rather than staying
  // pinned: on a small phone at the medium detent, a pinned block that tall
  // would leave the list no room. The preview stays pinned, so every change
  // shows while the list scrolls.
  const buttonsHeader = useMemo(
    () => (
      <View style={styles.buttonsHeader}>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.guidance}>
          {playerButtons.description}
        </Text>
        <Text
          variant="footnote"
          color={systemColors.secondaryLabel}
          style={styles.groupTitle}
          accessibilityRole="header"
        >
          {playerButtons.positionLabel}
        </Text>
        <SegmentedControl
          options={playerButtons.positionOptions}
          selectedKey={playerButtons.position}
          onSelect={playerButtons.onPositionChange}
          accessibilityLabel={playerButtons.positionLabel}
        />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <SwitchRow
            label={playerButtons.previousNextLabel}
            description={playerButtons.previousNextDescription}
            wrapDescription
            value={playerButtons.previousNext}
            onValueChange={playerButtons.onPreviousNextChange}
          />
        </View>
        <Text
          variant="footnote"
          color={systemColors.secondaryLabel}
          style={styles.groupTitle}
          accessibilityRole="header"
        >
          {playerButtons.title}
        </Text>
      </View>
    ),
    [
      systemColors.secondaryLabel,
      systemColors.secondaryBackground,
      playerButtons.description,
      playerButtons.positionLabel,
      playerButtons.positionOptions,
      playerButtons.position,
      playerButtons.onPositionChange,
      playerButtons.previousNextLabel,
      playerButtons.previousNextDescription,
      playerButtons.previousNext,
      playerButtons.onPreviousNextChange,
      playerButtons.title,
    ],
  );
  const buttonsFooter = useMemo(
    () => (
      <View style={styles.footer}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.guidance}>
          {playerButtons.footer}
        </Text>
        <View style={styles.restoreDefaults}>
          <Button
            title={playerButtons.restoreDefaultsLabel}
            onPress={playerButtons.restoreDefaults}
            disabled={!playerButtons.canRestoreDefaults}
            haptic={false}
            variant="text"
            minHeight={44}
            testID="player-buttons-restore-defaults"
          />
        </View>
      </View>
    ),
    [
      systemColors.secondaryLabel,
      playerButtons.footer,
      playerButtons.restoreDefaultsLabel,
      playerButtons.restoreDefaults,
      playerButtons.canRestoreDefaults,
    ],
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
          <SheetTopBar title={sections.sheetTitle} leading={{ kind: 'close', onPress: onClose }} />
          <View style={[styles.headerControls, contentGround]}>
            <SegmentedControl
              options={tabOptions}
              selectedKey={tab}
              onSelect={setTab}
              accessibilityLabel={sections.sheetTitle}
            />
            {tab === 'sections' ? (
              <>
                <Text variant="subheadline" color={systemColors.secondaryLabel}>
                  {sections.description}
                </Text>
                <View style={styles.actions}>
                  <View style={styles.actionSlot}>
                    <Button
                      title={sections.showAllLabel}
                      onPress={sections.showAll}
                      disabled={!sections.canShowAll}
                      haptic={false}
                      variant="text"
                      style={styles.actionButton}
                      minHeight={44}
                      testID="play-drawer-sections-show-all"
                    />
                  </View>
                  <View style={styles.actionSlot}>
                    <Button
                      title={sections.hideAllLabel}
                      onPress={sections.hideAll}
                      disabled={!sections.canHideAll}
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
                  {sections.groupTitle}
                </Text>
              </>
            ) : (
              <PlayerButtonsPreview
                buttons={playerButtons.buttons}
                previousNext={playerButtons.previousNext}
                position={playerButtons.position}
                board={previewBoard}
              />
            )}
          </View>
        </View>
      }
    >
      {tab === 'sections' ? (
        <SectionLayoutList
          key="sections"
          ListComponent={SectionsFlatList}
          style={[styles.list, contentGround]}
          contentContainerStyle={styles.listContent}
          rows={sections.controls}
          disabled={!sections.ready}
          onVisibleChange={sections.onSectionChange}
          onMove={sections.onMove}
          ListFooterComponent={sectionsFooter}
        />
      ) : (
        <SectionLayoutList
          key="buttons"
          ListComponent={ButtonsFlatList}
          style={[styles.list, contentGround]}
          contentContainerStyle={styles.listContent}
          rows={playerButtons.controls}
          onVisibleChange={playerButtons.onVisibleChange}
          onMove={playerButtons.onMove}
          ListHeaderComponent={buttonsHeader}
          ListFooterComponent={buttonsFooter}
        />
      )}
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
  buttonsHeader: { paddingVertical: spacing[2], gap: spacing[2] },
  // The Previous and next switch, grouped like the rows below it.
  card: { borderRadius: borderRadius.lg, overflow: 'hidden' },
  footer: { paddingVertical: spacing[3], gap: spacing[2] },
  guidance: { paddingHorizontal: spacing[4] },
  // Lines the action up with the guidance above it.
  restoreDefaults: { paddingHorizontal: spacing[4] },
});
