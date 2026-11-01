import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { useMovableFormRows } from '../../section-layout/use-movable-form-rows';
import { normaliseStartupScreen } from '../../../lib/app-entry-route';
import { hapticSelection } from '../../../lib/haptics';
import type { HomeSectionId } from '../../../lib/home-sections';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import { useSetting, type StartupScreen } from '../../../settings';
import { useHomeSectionControls } from '../../home/use-home-section-controls';
import { buildHomeSettingsModel } from './home-settings-model';

/**
 * Settings › Home. "Open the app on" first, then the sections with their
 * switches and ↑/↓ arrows (native form buttons on Android), then the presets. The rows and actions are the
 * Customize Home sheet's own (`useHomeSectionControls`) over the same store, so
 * the page, the sheet and Home always agree. Every change reports one
 * `Setting Changed` under the `homeScreen` page.
 */
export function HomeSettingsScreen() {
  const { t } = useTranslation('common');
  // Read by `getAppEntryTab()` on the next start; writing it moves nothing now.
  // Normalised the same way, so an unknown stored value shows Climbs chosen.
  const [storedStartupScreen, setStartupScreen] = useSetting('startupScreen');
  const startupScreen = normaliseStartupScreen(storedStartupScreen);
  const onStartupScreenChange = useCallback(
    (screen: StartupScreen) => {
      if (screen === startupScreen) return;
      hapticSelection();
      trackSettingChanged('homeScreen', 'startupScreen', screen);
      setStartupScreen(screen);
    },
    [startupScreen, setStartupScreen],
  );
  const {
    rows,
    onVisibleChange,
    onMove,
    showAll,
    applyFocused,
    restoreDefaults,
    canShowAll,
    canApplyFocused,
    canRestoreDefaults,
  } = useHomeSectionControls();
  // The native form's switch has no buzz of its own, unlike the sheet's.
  const onSectionChange = useCallback(
    (sectionId: HomeSectionId, visible: boolean) => {
      hapticSelection();
      onVisibleChange(sectionId, visible);
    },
    [onVisibleChange],
  );
  const movableRows = useMemo(() => rows.filter((row) => row.movable), [rows]);
  const fixedRows = useMemo(() => rows.filter((row) => !row.movable), [rows]);
  // Native switches with native move buttons on Android, the sheet's rows hosted
  // in one form row elsewhere; a native move buzzes and speaks like the sheet's arrows.
  const movableSections = useMovableFormRows({
    rows: movableRows,
    onVisibleChange,
    onMove,
    testID: 'home-settings-sections',
  });
  const model = useMemo(
    () =>
      buildHomeSettingsModel({
        t,
        startupScreen,
        onStartupScreenChange,
        movableSections,
        fixedRows,
        onSectionChange,
        canShowAll,
        onShowAll: showAll,
        canApplyFocused,
        onApplyFocused: applyFocused,
        canRestoreDefaults,
        onRestoreDefaults: restoreDefaults,
      }),
    [
      t,
      startupScreen,
      onStartupScreenChange,
      movableSections,
      fixedRows,
      onSectionChange,
      canShowAll,
      showAll,
      canApplyFocused,
      applyFocused,
      canRestoreDefaults,
      restoreDefaults,
    ],
  );
  return <MoreForm model={model} />;
}
