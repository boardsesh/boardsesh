import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
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
  onTogglePin: () => void;
  /** Enter the climbs edit mode (reorder + remove). */
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

/**
 * Owner overflow sheet — the collapsed form of the hero's pin · edit · delete
 * toolbar, shown once the hero scrolls away (and always on Material). The parent
 * wires Pin → toggle pin, Edit → enter the climbs reorder/remove mode, and
 * Delete → the confirm Alert.
 */
export function PlaylistActionsMenu({
  visible,
  isPinned,
  onTogglePin,
  onEdit,
  onDelete,
  onClose,
}: PlaylistActionsMenuProps) {
  const { t } = useTranslation('playlists');
  const { actionColors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);
  // Track presented state so we never call dismiss() on a not-presented modal
  // (which leaves gorhom in a state where the next present() is a no-op — the
  // "nothing happens" bug). Mirrors LogAscentSheet.
  const isPresentedRef = useRef(false);
  // 36% leaves room for the three rows on short screens (e.g. iPhone SE landscape).
  const snapPoints = useMemo(() => ['36%'], []);

  useEffect(() => {
    if (visible && !isPresentedRef.current) {
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!visible && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);
  // Monochrome on Liquid Glass, semantic on Material — resolved once as a token.
  const { accent: accentActionIconColor, pin: pinActionIconColor } = actionColors;

  return (
    <ModalSheet ref={sheetRef} snapPoints={snapPoints} onDismiss={handleDismiss}>
      <View style={styles.content}>
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
