import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '../SegmentedControl';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { usePlayDrawerSectionControls } from '../settings/use-play-drawer-section-controls';
import { usePlayerButtonControls } from '../settings/use-player-button-controls';
import {
  SectionLayoutSheetFooter,
  SectionLayoutSheetFrame,
  SectionLayoutSheetGroupTitle,
  SectionLayoutSheetIntro,
  SectionLayoutSheetList,
  sectionLayoutSheetStyles,
  type SectionLayoutSheetAction,
} from '../section-layout/SectionLayoutSheet';
import { PlayerButtonsPreview, type PlayerButtonsPreviewBoard } from '../player-buttons/PlayerButtonsPreview';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

type ViewOptionsTab = 'sections' | 'buttons';

type PlayDrawerSectionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The board on screen, so the buttons preview draws the bar this climber will see. */
  previewBoard: PlayerButtonsPreviewBoard;
  /** List the MoonBoard-only Active holds switch: the climb on screen or the active board is a MoonBoard. */
  listsActiveHolds?: boolean;
};

/**
 * ⋯ → View options. Two tabs: the sections below the climb, and the player's
 * buttons (#6229). Choices apply at once; there is no save step. Keep mounted
 * inside PlayDrawer so its managed presenter sits above /play.
 */
export function PlayDrawerSectionsSheet({
  visible,
  onClose,
  previewBoard,
  listsActiveHolds,
}: PlayDrawerSectionsSheetProps) {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<ViewOptionsTab>('sections');
  const sections = usePlayDrawerSectionControls({ listsActiveHolds });
  const playerButtons = usePlayerButtonControls();
  const { systemColors } = useTheme();
  const tabOptions = useMemo<{ key: ViewOptionsTab; label: string }[]>(
    () => [
      { key: 'sections', label: t('mobile.settings.climbDrawer.tabs.sections') },
      { key: 'buttons', label: t('mobile.settings.climbDrawer.tabs.buttons') },
    ],
    [t],
  );

  const sectionActions = useMemo<[SectionLayoutSheetAction, SectionLayoutSheetAction]>(
    () => [
      {
        label: sections.showAllLabel,
        onPress: sections.showAll,
        disabled: !sections.canShowAll,
        testID: 'play-drawer-sections-show-all',
      },
      {
        label: sections.hideAllLabel,
        onPress: sections.hideAll,
        disabled: !sections.canHideAll,
        testID: 'play-drawer-sections-hide-all',
      },
    ],
    [
      sections.showAllLabel,
      sections.showAll,
      sections.canShowAll,
      sections.hideAllLabel,
      sections.hideAll,
      sections.canHideAll,
    ],
  );
  const sectionsRestore = useMemo<SectionLayoutSheetAction>(
    () => ({
      label: sections.restoreDefaultsLabel,
      onPress: sections.restoreDefaults,
      disabled: !sections.canRestoreDefaults,
      testID: 'play-drawer-sections-restore-defaults',
    }),
    [sections.restoreDefaultsLabel, sections.restoreDefaults, sections.canRestoreDefaults],
  );
  const buttonsRestore = useMemo<SectionLayoutSheetAction>(
    () => ({
      label: playerButtons.restoreDefaultsLabel,
      onPress: playerButtons.restoreDefaults,
      disabled: !playerButtons.canRestoreDefaults,
      testID: 'player-buttons-restore-defaults',
    }),
    [playerButtons.restoreDefaultsLabel, playerButtons.restoreDefaults, playerButtons.canRestoreDefaults],
  );

  const sectionsFooter = useMemo(
    () => <SectionLayoutSheetFooter guidance={sections.footer} restoreDefaults={sectionsRestore} />,
    [sections.footer, sectionsRestore],
  );
  const buttonsFooter = useMemo(
    () => <SectionLayoutSheetFooter guidance={playerButtons.footer} restoreDefaults={buttonsRestore} />,
    [playerButtons.footer, buttonsRestore],
  );

  // Scroll the description and actions away so large text cannot fill a small
  // phone's sheet above the switches. Only the tab selector stays pinned.
  const sectionsHeader = useMemo(
    () => (
      <View style={sectionLayoutSheetStyles.listIntro}>
        <SectionLayoutSheetIntro
          description={sections.description}
          actions={sectionActions}
          groupTitle={sections.groupTitle}
        />
      </View>
    ),
    [sections.description, sectionActions, sections.groupTitle],
  );

  // The position and Previous and next scroll with the list rather than staying
  // pinned: on a small phone at the medium detent, a pinned block that tall
  // would leave the list no room. The preview stays pinned, so every change
  // shows while the list scrolls.
  const buttonsHeader = useMemo(
    () => (
      <View style={styles.buttonsHeader}>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={sectionLayoutSheetStyles.guidance}>
          {playerButtons.description}
        </Text>
        <SectionLayoutSheetGroupTitle title={playerButtons.positionLabel} />
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
        <SectionLayoutSheetGroupTitle title={playerButtons.title} />
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

  return (
    <SectionLayoutSheetFrame
      visible={visible}
      onClose={onClose}
      title={sections.sheetTitle}
      header={
        <>
          <SegmentedControl
            options={tabOptions}
            selectedKey={tab}
            onSelect={setTab}
            accessibilityLabel={sections.sheetTitle}
          />
          {tab === 'buttons' ? (
            <PlayerButtonsPreview
              buttons={playerButtons.buttons}
              previousNext={playerButtons.previousNext}
              position={playerButtons.position}
              board={previewBoard}
            />
          ) : null}
        </>
      }
    >
      {tab === 'sections' ? (
        <SectionLayoutSheetList
          key="sections"
          rows={sections.controls}
          disabled={!sections.ready}
          onVisibleChange={sections.onSectionChange}
          onMove={sections.onMove}
          ListHeaderComponent={sectionsHeader}
          ListFooterComponent={sectionsFooter}
        />
      ) : (
        <SectionLayoutSheetList
          key="buttons"
          rows={playerButtons.controls}
          onVisibleChange={playerButtons.onVisibleChange}
          onMove={playerButtons.onMove}
          ListHeaderComponent={buttonsHeader}
          ListFooterComponent={buttonsFooter}
        />
      )}
    </SectionLayoutSheetFrame>
  );
}

const styles = StyleSheet.create({
  buttonsHeader: { paddingVertical: spacing[2], gap: spacing[2] },
  // The Previous and next switch, grouped like the rows below it.
  card: { borderRadius: borderRadius.lg, overflow: 'hidden' },
});
