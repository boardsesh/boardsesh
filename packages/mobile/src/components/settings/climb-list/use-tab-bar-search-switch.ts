import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetting } from '../../../settings';
import { useConfirm } from '../../../providers/dialog-provider';
import { hapticSelection } from '../../../lib/haptics';
import { restartApp } from '../../../lib/app-restart';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import {
  climbsTabBarSearchLaunchChoice,
  useClimbsTabBarSearchAvailable,
} from '../../../hooks/use-climbs-tab-bar-search';

/**
 * The View options "Search from the tab bar" switch. The tab bar reads the
 * choice once per launch (`climbsTabBarSearchLaunchChoice`), so a flip asks to
 * restart now. Flipping back to what this launch runs with needs no restart and
 * asks nothing. "Later" keeps the stored choice for the next start. `null` where
 * the bar has no search tab.
 */
export function useTabBarSearchSwitch(): { enabled: boolean; onChange: (enabled: boolean) => void } | null {
  const { t } = useTranslation('common');
  const confirm = useConfirm();
  const available = useClimbsTabBarSearchAvailable();
  const [enabled, setEnabled] = useSetting('climbsTabBarSearch');

  const onChange = useCallback(
    (next: boolean) => {
      hapticSelection();
      setEnabled(next);
      trackSettingChanged('climbList', 'climbsTabBarSearch', next);
      if (next === climbsTabBarSearchLaunchChoice()) return;
      void confirm({
        title: t('mobile.settings.tabBarSearch.restartTitle'),
        message: t('mobile.settings.tabBarSearch.restartMessage'),
        confirmLabel: t('mobile.settings.tabBarSearch.restartNow'),
        cancelLabel: t('mobile.settings.tabBarSearch.restartLater'),
      }).then((restart) => {
        if (restart) void restartApp();
      });
    },
    [confirm, setEnabled, t],
  );

  return useMemo(() => (available ? { enabled, onChange } : null), [available, enabled, onChange]);
}
