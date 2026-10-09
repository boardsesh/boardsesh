import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLAY_DRAWER_SECTION_IDS,
  usePlayDrawerSectionsPreference,
  type PlayDrawerSectionId,
} from '../../lib/play-drawer-sections-preference';
import { hapticSelection } from '../../lib/haptics';
import type { MoreSection } from '../MoreForm.types';

export type PlayDrawerSectionControl = { id: PlayDrawerSectionId; label: string; enabled: boolean };

/** Shared order, labels and actions for Settings and the drawer's sheet. */
export function usePlayDrawerSectionControls() {
  const { t } = useTranslation('common');
  const { sections, ready, setSection, setAll } = usePlayDrawerSectionsPreference();
  const title = t('mobile.settings.climbDrawer.title');
  const description = t('mobile.settings.climbDrawer.description');
  const loadingLabel = t('mobile.settings.climbDrawer.loading');
  const hideAllLabel = t('mobile.settings.climbDrawer.hideAll');
  const showAllLabel = t('mobile.settings.climbDrawer.showAll');
  const logbookLabel = t('mobile.settings.climbDrawer.sections.logbook');
  const climberLogsLabel = t('mobile.settings.climbDrawer.sections.climberLogs');
  const setterNotesLabel = t('mobile.settings.climbDrawer.sections.setterNotes');
  const betaVideosLabel = t('mobile.settings.climbDrawer.sections.betaVideos');
  const boardseshGradeLabel = t('mobile.settings.climbDrawer.sections.boardseshGrade');
  const communityLabel = t('mobile.settings.climbDrawer.sections.community');
  const similarClimbsLabel = t('mobile.settings.climbDrawer.sections.similarClimbs');
  const controls = useMemo<PlayDrawerSectionControl[]>(() => {
    const labels = {
      logbook: logbookLabel,
      climberLogs: climberLogsLabel,
      setterNotes: setterNotesLabel,
      betaVideos: betaVideosLabel,
      boardseshGrade: boardseshGradeLabel,
      community: communityLabel,
      similarClimbs: similarClimbsLabel,
    };
    return PLAY_DRAWER_SECTION_IDS.map((id) => ({ id, label: labels[id], enabled: sections[id] }));
  }, [
    sections,
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
  const hideAll = useCallback(() => {
    if (!ready) return;
    hapticSelection();
    setAll(false);
  }, [ready, setAll]);
  const showAll = useCallback(() => {
    if (!ready) return;
    hapticSelection();
    setAll(true);
  }, [ready, setAll]);
  const settingsSection = useMemo<MoreSection>(
    () => ({
      key: 'climbDrawer',
      title,
      footer: description,
      // MoreForm's native toggle model has no disabled state; withhold actions
      // until storage settles so loading cannot overwrite a saved choice.
      rows: ready
        ? [
            ...controls.map((control) => ({
              kind: 'toggle' as const,
              key: control.id,
              label: control.label,
              value: control.enabled,
              onValueChange: (enabled: boolean) => {
                hapticSelection();
                onSectionChange(control.id, enabled);
              },
            })),
            { kind: 'button', key: 'hideAll', label: hideAllLabel, onPress: hideAll },
            { kind: 'button', key: 'showAll', label: showAllLabel, onPress: showAll },
          ]
        : [{ kind: 'info', key: 'loading', label: loadingLabel, body: '' }],
    }),
    [title, description, ready, controls, onSectionChange, hideAllLabel, showAllLabel, hideAll, showAll, loadingLabel],
  );
  return {
    title,
    description,
    ready,
    controls,
    onSectionChange,
    hideAllLabel,
    showAllLabel,
    hideAll,
    showAll,
    settingsSection,
  };
}
