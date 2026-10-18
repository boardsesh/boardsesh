import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { usePersonalGradesActive } from '../../../hooks/use-personal-grades';
import { useBoardseshGradesPreference } from '../../../lib/boardsesh-grades-preference';
import { usePersonalGradesPreference } from '../../../lib/personal-grades-preference';
import { useClimbRowDisplay } from '../../../lib/climb-row-display-preference';
import { matchClimbRowPreset } from '../../../lib/climb-row-display';
import { hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useBoardseshGradeEnabled } from '../../../providers/feature-flags-provider';
import { climbRowPresetLabel } from '../climb-list/climb-list-settings-model';
import {
  isDefaultPlayDrawerLayout,
  usePlayDrawerSectionsPreference,
} from '../../../lib/play-drawer-sections-preference';
import { isDefaultPlayerButtons, usePlayerButtonsPreference } from '../../../lib/player-buttons-preference';
import { buildClimbsModel } from './climbs-model';

export function ClimbsSettingsScreen() {
  const { t } = useTranslation('common');
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  // Personal grades are user config; the `personal-grades` flag only supplies
  // the default. The row therefore shows the RESOLVED value (setting, else flag
  // default) and writes an explicit choice on toggle, so flipping it and back
  // leaves a deliberate decision behind, not a return to whatever the flag
  // happens to say later.
  const personalGradesActive = usePersonalGradesActive();
  const { setEnabled: setPersonalGrades } = usePersonalGradesPreference();
  const boardseshGradeFlagEnabled = useBoardseshGradeEnabled();
  const { enabled: showBoardseshGrades, setEnabled: setShowBoardseshGrades } = useBoardseshGradesPreference();
  const climbRowDisplay = useClimbRowDisplay();
  const sectionsPreference = usePlayDrawerSectionsPreference();
  const playerButtons = usePlayerButtonsPreference();
  // Until the sections' stored record lands, they read as the defaults.
  const climbViewIsDefault =
    isDefaultPlayerButtons(playerButtons) &&
    (!sectionsPreference.ready || isDefaultPlayDrawerLayout(sectionsPreference));

  const model = useMemo(
    () =>
      withSettingTracking(
        buildClimbsModel({
          t,
          gradeFormat,
          onGradeFormatChange: (format) => {
            hapticSelection();
            setGradeFormat(format);
          },
          personalGrades: personalGradesActive,
          onPersonalGradesChange: (enabled) => {
            hapticSelection();
            setPersonalGrades(enabled);
          },
          boardseshGrades: boardseshGradeFlagEnabled
            ? {
                enabled: showBoardseshGrades,
                onChange: (enabled) => {
                  hapticSelection();
                  setShowBoardseshGrades(enabled);
                },
              }
            : null,
          climbListPresetLabel: climbRowPresetLabel(matchClimbRowPreset(climbRowDisplay), t),
          onOpenClimbList: () => {
            hapticSelection();
            router.push('/settings/climb-list');
          },
          climbViewLabel: climbViewIsDefault
            ? t('mobile.settings.climbView.valueDefault')
            : t('mobile.settings.climbView.valueCustom'),
          onOpenClimbView: () => {
            hapticSelection();
            router.push('/settings/climb-view');
          },
        }),
        'climbs',
      ),
    [
      t,
      gradeFormat,
      setGradeFormat,
      personalGradesActive,
      setPersonalGrades,
      boardseshGradeFlagEnabled,
      showBoardseshGrades,
      setShowBoardseshGrades,
      climbRowDisplay,
      climbViewIsDefault,
    ],
  );

  return <MoreForm model={model} />;
}
