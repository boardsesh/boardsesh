import { useCallback, type ReactElement, type RefObject } from 'react';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppMenu } from '../AppMenu';
import type { AppMenuHandle } from '../AppMenu.types';
import type { PlayDrawerMenuRow } from '../play-drawer/play-drawer-menu-rows';

/** Shared native presentation for list, logbook, queue, and player actions. */
export function ClimbMenu({
  rows,
  menuKey,
  children,
  style,
  accessibilityLabel,
  iconAppearance = 'filled',
  liftPreview = false,
  previewBackgroundColor,
  previewOverlayColor,
  menuRef,
}: {
  rows: PlayDrawerMenuRow[];
  menuKey: string;
  children?: ReactElement;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  iconAppearance?: 'filled' | 'plain';
  liftPreview?: boolean;
  previewBackgroundColor?: ColorValue;
  previewOverlayColor?: ColorValue;
  /** A hold menu's opener, for a ⋮ button drawn beside the row. */
  menuRef?: RefObject<AppMenuHandle | null>;
}) {
  const { t } = useTranslation('climbs');
  const select = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row && !row.disabled) row.run();
    },
    [rows],
  );
  if (rows.length === 0) return children ?? null;
  const label = accessibilityLabel ?? t('mobile.climbRow.moreActions');
  // A row's hold menu is never remounted on a new target: that would remount
  // the row it wraps (thumbnail, board-art request) on every recycled cell. It
  // takes the key as data and retires only its drawn menu. The ⋯ button holds
  // no row, so a remount is the cheap, certain way to close it.
  return children ? (
    <AppMenu
      actions={rows}
      onSelectIndex={select}
      trigger="longPress"
      menuKey={menuKey}
      menuRef={menuRef}
      style={style}
      liftPreview={liftPreview}
      previewBackgroundColor={previewBackgroundColor}
      previewOverlayColor={previewOverlayColor}
    >
      {children}
    </AppMenu>
  ) : (
    <AppMenu
      key={menuKey}
      iconName="more"
      iconAppearance={iconAppearance}
      accessibilityLabel={label}
      actions={rows}
      onSelectIndex={select}
      style={style}
    />
  );
}
