import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AppMenu, type AppMenuAction } from '../AppMenu';

type PlaylistActionsMenuProps = {
  isPinned: boolean;
  onTogglePin: () => void;
  /** Head to the Climbs tab to pick something to add. Omit to hide the row (the
   *  playlist belongs to another board, or the viewer is not the owner). */
  onAddClimbs?: () => void;
  /** Open the edit-details sheet — name, description, colour, icon, visibility. */
  onEditDetails: () => void;
  /** Enter the climbs edit mode (reorder + remove). */
  onEdit: () => void;
  onDelete: () => void;
};

type MenuEntry = { action: AppMenuAction; run: () => void };

/**
 * Owner overflow menu — the collapsed form of the hero's pin · edit · delete
 * toolbar, shown once the hero scrolls away (and ALWAYS on Material, where it is
 * the only owner affordance). Rows: pin · add climbs · edit details · reorder &
 * remove climbs · delete.
 *
 * HIG Pull-down buttons: five or fewer plain actions with no rich content are a
 * menu off the ⋯ button, not a sheet. `AppMenu` is a native UIMenu on iOS and a
 * dropdown on Android; the delete row takes the destructive role.
 */
export function PlaylistActionsMenu({
  isPinned,
  onTogglePin,
  onAddClimbs,
  onEditDetails,
  onEdit,
  onDelete,
}: PlaylistActionsMenuProps) {
  const { t } = useTranslation('playlists');

  const entries = useMemo<MenuEntry[]>(() => {
    const list: MenuEntry[] = [
      {
        action: {
          label: isPinned ? t('library.pin.unpin') : t('library.pin.pin'),
          systemIcon: isPinned ? 'pin.slash' : 'pin',
        },
        run: onTogglePin,
      },
    ];
    if (onAddClimbs) {
      list.push({ action: { label: t('detail.menu.addClimbs'), systemIcon: 'plus' }, run: onAddClimbs });
    }
    list.push(
      { action: { label: t('detail.menu.editDetails'), systemIcon: 'gearshape' }, run: onEditDetails },
      { action: { label: t('detail.menu.editClimbs'), systemIcon: 'pencil' }, run: onEdit },
      { action: { label: t('detail.menu.delete'), systemIcon: 'trash', destructive: true }, run: onDelete },
    );
    return list;
  }, [isPinned, onTogglePin, onAddClimbs, onEditDetails, onEdit, onDelete, t]);

  const actions = useMemo(() => entries.map((entry) => entry.action), [entries]);
  const handleSelect = useCallback((index: number) => entries[index]?.run(), [entries]);

  return (
    <AppMenu iconName="more" accessibilityLabel={t('detail.actions')} actions={actions} onSelectIndex={handleSelect} />
  );
}
