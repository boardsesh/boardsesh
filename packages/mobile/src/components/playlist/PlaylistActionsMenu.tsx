import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type PlaylistActionsMenuProps = {
  visible: boolean;
  isPinned: boolean;
  onTogglePin?: () => void;
  /** Head to the Climbs tab to pick something to add. Omit to hide the row (the
   *  playlist belongs to another board, or the viewer is not the owner). */
  onAddClimbs?: () => void;
  /** Open the edit-details sheet — name, description, colour, icon, visibility. */
  onEditDetails: () => void;
  /** Enter the climbs edit mode (reorder + remove). */
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

/**
 * Owner overflow sheet — the collapsed form of the hero's pin · edit · delete
 * toolbar, shown once the hero scrolls away (and ALWAYS on Material, where it is
 * the only owner affordance). Rows: pin · add climbs · edit details · reorder &
 * remove climbs · delete.
 *
 * Every row's handler must do its work immediately. `onClose` only fires on a
 * user pan-down or backdrop tap — the sheet coordinator suppresses it for a
 * controlled `visible: true -> false` — so a handler that defers to `onClose`
 * silently does nothing (#3966).
 */
export function PlaylistActionsMenu({
  visible,
  isPinned,
  onTogglePin,
  onAddClimbs,
  onEditDetails,
  onEdit,
  onDelete,
  onClose,
}: PlaylistActionsMenuProps) {
  const { t } = useTranslation('playlists');
  const { actionColors } = useTheme();
  // Room for four rows, or five when the add-climbs row is shown, on short
  // screens (e.g. iPhone SE landscape).
  const snapPoints = useMemo(() => [onAddClimbs ? '56%' : '46%'], [onAddClimbs]);
  // Monochrome on Liquid Glass, semantic on Material — resolved once as a token.
  const { accent: accentActionIconColor, pin: pinActionIconColor } = actionColors;

  return (
    <ModalSheet visible={visible} snapPoints={snapPoints} onClose={onClose}>
      <View style={styles.content}>
        {onTogglePin ? (
          <ListRow
            title={isPinned ? t('library.pin.unpin') : t('library.pin.pin')}
            leading={
              <Icon
                name={isPinned ? 'pin.fill' : 'pin'}
                size={22}
                color={isPinned ? pinActionIconColor : accentActionIconColor}
              />
            }
            onPress={onTogglePin}
            showSeparator
          />
        ) : null}
        {onAddClimbs ? (
          <ListRow
            title={t('detail.menu.addClimbs')}
            leading={<Icon name="add" size={22} color={accentActionIconColor} />}
            onPress={onAddClimbs}
            showSeparator
          />
        ) : null}
        <ListRow
          title={t('detail.menu.editDetails')}
          leading={<Icon name="settings" size={22} color={accentActionIconColor} />}
          onPress={onEditDetails}
          showSeparator
        />
        <ListRow
          title={t('detail.menu.editClimbs')}
          leading={<Icon name="edit" size={22} color={accentActionIconColor} />}
          onPress={onEdit}
          showSeparator
        />
        <ListRow
          title={t('detail.menu.delete')}
          leading={<Icon name="delete" size={22} color={iosSystemColors.systemRed} />}
          onPress={onDelete}
          showSeparator={false}
        />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
});
