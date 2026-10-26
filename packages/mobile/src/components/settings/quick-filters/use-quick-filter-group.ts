import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { filterChipLabel } from '../../../lib/filter-chip-labels';
import { hapticSelection } from '../../../lib/haptics';
import type { FilterChipKind } from '../../../lib/pinnable-chips';
import { canMovePinnedChip, type PinnedChipsStore } from '../../../lib/pinned-chips-store';
import type { SectionMoveDirection } from '../../../lib/section-layout';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import { useMovableFormRows } from '../../section-layout/use-movable-form-rows';
import {
  isDefaultPinOrder,
  quickFilterRows,
  type QuickFilterGroupInput,
  type QuickFilterSurface,
} from './quick-filters-settings-model';

// Every Quick filters edit reports `Setting Changed` under this page. Keys name
// the surface and the kind (`climbs.grade`) or the move (`climbs.moveUp`, with
// the kind as the value); never a label.
export const QUICK_FILTERS_ANALYTICS_PAGE = 'quickFilters';

/**
 * One pin store as a Quick filters group: its rows (labelled as the Filters
 * sheet names each control), the switch and move handlers, and its defaults.
 * The page and the chip rows read the same store, so a change here is on the
 * list the moment you go back.
 */
export function useQuickFilterGroup<K extends FilterChipKind>(store: PinnedChipsStore<K>, surface: QuickFilterSurface) {
  const { t } = useTranslation('climbs');
  const { pinned, loaded } = store.usePinnedChips();
  const rows = useMemo(
    () => quickFilterRows(store.catalog, pinned, (kind) => filterChipLabel(kind, t)),
    [store, pinned, t],
  );
  const pinnedRows = useMemo(() => rows.filter((row) => row.movable), [rows]);
  const unpinnedRows = useMemo(() => rows.filter((row) => !row.movable), [rows]);

  // The hosted rows' switch buzzes by itself; the native form's switch does not.
  const onHostedPinChange = useCallback(
    (kind: K, pin: boolean) => {
      if (pinned.includes(kind) === pin) return;
      trackSettingChanged(QUICK_FILTERS_ANALYTICS_PAGE, `${surface}.${kind}`, pin);
      void store.toggle(kind);
    },
    [pinned, store, surface],
  );
  const onPinChange = useCallback(
    (kind: K, pin: boolean) => {
      if (pinned.includes(kind) === pin) return;
      hapticSelection();
      onHostedPinChange(kind, pin);
    },
    [pinned, onHostedPinChange],
  );
  // False when the kind cannot go that way, so nothing buzzes or announces a
  // move that did not happen.
  const onMove = useCallback(
    (kind: K, direction: SectionMoveDirection): boolean => {
      if (!loaded || !canMovePinnedChip(pinned, kind, direction)) return false;
      trackSettingChanged(QUICK_FILTERS_ANALYTICS_PAGE, `${surface}.${direction === -1 ? 'moveUp' : 'moveDown'}`, kind);
      void store.move(kind, direction);
      return true;
    },
    [loaded, pinned, store, surface],
  );

  const movable = useMovableFormRows({
    rows: pinnedRows,
    disabled: !loaded,
    onVisibleChange: onHostedPinChange,
    onMove,
    testID: `quick-filters-${surface}`,
  });
  const group = useMemo<QuickFilterGroupInput<K>>(
    () => ({ pinned: movable, pinnedCount: pinnedRows.length, unpinnedRows, onPinChange, disabled: !loaded }),
    [movable, pinnedRows.length, unpinnedRows, onPinChange, loaded],
  );
  const isDefault = isDefaultPinOrder(pinned, store.defaults);
  const restoreDefaults = useCallback(() => {
    void store.set(store.defaults);
  }, [store]);
  return { group, isDefault, restoreDefaults };
}
