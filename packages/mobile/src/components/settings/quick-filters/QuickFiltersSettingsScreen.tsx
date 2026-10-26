import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { hapticSelection } from '../../../lib/haptics';
import { climbPinnedChipsStore } from '../../../lib/pinned-chips-store';
import { playlistPinnedChipsStore } from '../../../lib/playlist-pinned-chips-store';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import { buildQuickFiltersSettingsModel } from './quick-filters-settings-model';
import { QUICK_FILTERS_ANALYTICS_PAGE, useQuickFilterGroup } from './use-quick-filter-group';

/**
 * Settings › Climbs & grades › Quick filters: which filters sit as chips above
 * the Climbs list and above playlists, smart playlists and setter pages, and in
 * what order. Built like Settings › Home: on iOS and the browser the pinned
 * filters are the sheet's switch-and-arrows rows hosted in one form row, on
 * Android native switches with native move buttons; the rest are plain
 * switches. Also pushed from the Climbs and Discover stacks, so the Filters
 * sheet can open it over its own list.
 */
export function QuickFiltersSettingsScreen() {
  const { t } = useTranslation('common');
  const climbs = useQuickFilterGroup(climbPinnedChipsStore, 'climbs');
  const playlists = useQuickFilterGroup(playlistPinnedChipsStore, 'playlists');
  const canRestoreDefaults = !climbs.isDefault || !playlists.isDefault;
  const { restoreDefaults: restoreClimbs, isDefault: climbsAreDefault } = climbs;
  const { restoreDefaults: restorePlaylists, isDefault: playlistsAreDefault } = playlists;
  const onRestoreDefaults = useCallback(() => {
    if (climbsAreDefault && playlistsAreDefault) return;
    hapticSelection();
    trackSettingChanged(QUICK_FILTERS_ANALYTICS_PAGE, 'preset', 'default');
    if (!climbsAreDefault) restoreClimbs();
    if (!playlistsAreDefault) restorePlaylists();
  }, [climbsAreDefault, playlistsAreDefault, restoreClimbs, restorePlaylists]);
  const model = useMemo(
    () =>
      buildQuickFiltersSettingsModel({
        t,
        climbs: climbs.group,
        playlists: playlists.group,
        canRestoreDefaults,
        onRestoreDefaults,
      }),
    [t, climbs.group, playlists.group, canRestoreDefaults, onRestoreDefaults],
  );
  return <MoreForm model={model} />;
}
