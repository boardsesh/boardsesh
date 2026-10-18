import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BELOW_FOLD_SECTION_IDS,
  BOARD_SECTION_IDS,
  isDefaultPlayDrawerLayout,
  usePlayDrawerSectionsPreference,
  type BelowFoldSectionId,
  type PlayDrawerSectionId,
} from '../../lib/play-drawer-sections-preference';
import type { SectionMoveDirection } from '../../lib/section-layout';
import { hapticSelection } from '../../lib/haptics';
import type { MoreSection } from '../MoreForm.types';
import type { SectionLayoutRowModel } from '../section-layout/SectionLayoutList';

export type PlayDrawerSectionControl = SectionLayoutRowModel<PlayDrawerSectionId>;

function isBelowFoldSection(sectionId: PlayDrawerSectionId): sectionId is BelowFoldSectionId {
  return (BELOW_FOLD_SECTION_IDS as readonly PlayDrawerSectionId[]).includes(sectionId);
}

/** Shared order, labels and actions for Settings and the drawer's sheet. */
export function usePlayDrawerSectionControls() {
  const { t } = useTranslation('common');
  const { sections, order, ready, setSection, setAll, move, restoreDefaults } = usePlayDrawerSectionsPreference();
  const sheetTitle = t('mobile.settings.climbDrawer.sheetTitle');
  const description = t('mobile.settings.climbDrawer.description');
  // "Below the climb": the sheet's group heading and the Settings section's
  // title, so both name the same place.
  const groupTitle = t('mobile.settings.climbDrawer.groupTitle');
  // Settings says where else this lives, and where the order changes: the
  // climb's ⋯ menu, under View options.
  const settingsFooter = t('mobile.settings.climbDrawer.settingsFooter');
  const footer = t('mobile.settings.climbDrawer.footer');
  const loadingLabel = t('mobile.settings.climbDrawer.loading');
  const hideAllLabel = t('mobile.settings.climbDrawer.hideAll');
  const showAllLabel = t('mobile.settings.climbDrawer.showAll');
  const restoreDefaultsLabel = t('mobile.settings.climbDrawer.restoreDefaults');
  const logbookLabel = t('mobile.settings.climbDrawer.sections.logbook');
  const climberLogsLabel = t('mobile.settings.climbDrawer.sections.climberLogs');
  const setterNotesLabel = t('mobile.settings.climbDrawer.sections.setterNotes');
  const betaVideosLabel = t('mobile.settings.climbDrawer.sections.betaVideos');
  const boardseshGradeLabel = t('mobile.settings.climbDrawer.sections.boardseshGrade');
  const communityLabel = t('mobile.settings.climbDrawer.sections.community');
  const similarClimbsLabel = t('mobile.settings.climbDrawer.sections.similarClimbs');
  const controls = useMemo<PlayDrawerSectionControl[]>(() => {
    const labels: Record<PlayDrawerSectionId, string> = {
      logbook: logbookLabel,
      climberLogs: climberLogsLabel,
      setterNotes: setterNotesLabel,
      betaVideos: betaVideosLabel,
      boardseshGrade: boardseshGradeLabel,
      community: communityLabel,
      similarClimbs: similarClimbsLabel,
    };
    // Board sections keep their place under the board: a switch and no arrows,
    // ahead of the below-the-fold sections in the climber's order.
    return [
      ...BOARD_SECTION_IDS.map((id) => ({ id, label: labels[id], visible: sections[id], movable: false })),
      ...order.map((id) => ({ id, label: labels[id], visible: sections[id], movable: true })),
    ];
  }, [
    sections,
    order,
    logbookLabel,
    climberLogsLabel,
    setterNotesLabel,
    betaVideosLabel,
    boardseshGradeLabel,
    communityLabel,
    similarClimbsLabel,
  ]);
  const onSectionChange = useCallback(
    (sectionId: PlayDrawerSectionId, enabled: boolean) => {
      if (!ready) return;
      setSection(sectionId, enabled);
    },
    [ready, setSection],
  );
  const onMove = useCallback(
    (sectionId: PlayDrawerSectionId, direction: SectionMoveDirection) => {
      if (!ready || !isBelowFoldSection(sectionId)) return;
      move(sectionId, direction);
    },
    [ready, move],
  );
  const canShowAll = ready && controls.some((control) => !control.visible);
  const canHideAll = ready && controls.some((control) => control.visible);
  const canRestoreDefaults = ready && !isDefaultPlayDrawerLayout({ sections, order });
  const hideAll = useCallback(() => {
    if (!canHideAll) return;
    hapticSelection();
    setAll(false);
  }, [canHideAll, setAll]);
  const showAll = useCallback(() => {
    if (!canShowAll) return;
    hapticSelection();
    setAll(true);
  }, [canShowAll, setAll]);
  const handleRestoreDefaults = useCallback(() => {
    if (!canRestoreDefaults) return;
    hapticSelection();
    restoreDefaults();
  }, [canRestoreDefaults, restoreDefaults]);
  const settingsSection = useMemo<MoreSection>(
    () => ({
      key: 'climbDrawer',
      title: groupTitle,
      footer: settingsFooter,
      // MoreForm's native toggle model has no disabled state; withhold actions
      // until storage settles so loading cannot overwrite a saved choice.
      rows: ready
        ? [
            ...controls.map((control) => ({
              kind: 'toggle' as const,
              key: control.id,
              label: control.label,
              value: control.visible,
              onValueChange: (enabled: boolean) => {
                hapticSelection();
                onSectionChange(control.id, enabled);
              },
            })),
            { kind: 'button', key: 'hideAll', label: hideAllLabel, onPress: hideAll },
            { kind: 'button', key: 'showAll', label: showAllLabel, onPress: showAll },
            {
              kind: 'button',
              key: 'restoreDefaults',
              label: restoreDefaultsLabel,
              disabled: !canRestoreDefaults,
              onPress: handleRestoreDefaults,
            },
          ]
        : [{ kind: 'info', key: 'loading', label: loadingLabel, body: '' }],
    }),
    [
      groupTitle,
      settingsFooter,
      ready,
      controls,
      onSectionChange,
      hideAllLabel,
      showAllLabel,
      hideAll,
      showAll,
      restoreDefaultsLabel,
      canRestoreDefaults,
      handleRestoreDefaults,
      loadingLabel,
    ],
  );
  return {
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
    restoreDefaults: handleRestoreDefaults,
    canShowAll,
    canHideAll,
    canRestoreDefaults,
    settingsSection,
  };
}
