import { useCallback, useRef, useImperativeHandle } from 'react';
import { Platform, StyleSheet, View, type ViewInstance } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import type { AppMenuHandle } from '../AppMenu.types';
import { Icon } from '../Icon';
import { StaticPressableSurface } from '../PressableSurface';
import { ClimbMenu } from './ClimbMenu';
import type { ClimbListRowMenuProps } from './ClimbListRowMenu.types';

/**
 * Android/browser and rows without an ellipsis retain their native menu. The ⋮
 * is a plain button that opens the row's own hold menu, so a row carries one
 * menu, and on Android no Compose host until it is first opened.
 */
export function FallbackClimbListRowMenu(props: ClimbListRowMenuProps) {
  const { systemColors } = useTheme();
  const menuRef = useRef<AppMenuHandle | null>(null);
  const moreButtonRef = useRef<ViewInstance | null>(null);
  const currentMenuKeyRef = useRef(props.menuKey);
  currentMenuKeyRef.current = props.menuKey;
  const openMenu = useCallback(() => menuRef.current?.open(), []);
  const openFromMoreButton = useCallback(() => {
    if (Platform.OS !== 'web') {
      openMenu();
      return;
    }
    const menuKey = currentMenuKeyRef.current;
    moreButtonRef.current?.measureInWindow((left, top, _width, height) => {
      if (menuKey === currentMenuKeyRef.current) menuRef.current?.open({ x: left, y: top + height });
    });
  }, [openMenu]);
  useImperativeHandle(props.ref, () => ({ open: openMenu }), [openMenu]);
  return (
    <>
      <ClimbMenu
        rows={props.rows}
        onPresented={props.onPresented}
        menuKey={props.menuKey}
        menuRef={menuRef}
        style={props.bodyStyle}
        liftPreview
        previewOverlayColor={props.previewOverlayColor}
      >
        {props.children}
      </ClimbMenu>
      {props.showMoreButton && props.rows.length > 0 ? (
        <View ref={moreButtonRef} testID="climb-row-more-button" style={props.moreButtonStyle}>
          <StaticPressableSurface
            onPress={openFromMoreButton}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            style={styles.moreButton}
          >
            <Icon name="more.vertical" size={20} color={systemColors.secondaryLabel} />
          </StaticPressableSurface>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  moreButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
