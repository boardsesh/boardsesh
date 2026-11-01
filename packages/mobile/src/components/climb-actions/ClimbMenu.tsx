import { useCallback, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppMenu } from '../AppMenu';
import type { PlayDrawerMenuRow } from '../play-drawer/play-drawer-menu-rows';

/** Shared native presentation for list, logbook, queue, and player actions. */
export function ClimbMenu({
  rows,
  menuKey,
  children,
  style,
  accessibilityLabel,
  iconAppearance = 'filled',
}: {
  rows: PlayDrawerMenuRow[];
  menuKey: string;
  children?: ReactElement;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  iconAppearance?: 'filled' | 'plain';
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
  return children ? (
    <AppMenu key={menuKey} actions={rows} onSelectIndex={select} trigger="longPress" style={style}>
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
