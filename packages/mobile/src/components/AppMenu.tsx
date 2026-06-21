import { useState, type ReactNode } from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import ContextMenu, { type ContextMenuAction } from 'react-native-context-menu-view';
import { Menu } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { createVariantComponent } from '../theme/variants';

/** A single menu row, neutral across the two backing libraries. */
export type AppMenuAction = {
  label: string;
  /** Marks the active row (a checkmark on Material / native iOS, a ✓-prefix on Android glass). */
  selected?: boolean;
  destructive?: boolean;
  /**
   * SF Symbol name for the native iOS dropdown (Liquid Glass) — e.g. `person.2.fill`.
   * Glass-only: Paper's Material menu doesn't render SF Symbols, so it's ignored there.
   */
  systemIcon?: string;
};

export type AppMenuProps = {
  actions: AppMenuAction[];
  /** Called with the index of the tapped action, matching `actions` order. */
  onSelectIndex: (index: number) => void;
  /** The pressable anchor content (e.g. a title pill). */
  children: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * A dropdown menu anchored to its `children`, rendered per UI variant: a Material 3
 * Paper `Menu` on Material and the native iOS dropdown (`react-native-context-menu-view`)
 * on Liquid Glass. One neutral `{ label, selected, destructive }` action shape so
 * neither library's prop names leak to callers.
 */
export const AppMenu = createVariantComponent('AppMenu', { liquidGlass: AppMenuGlass, material: AppMenuMaterial });

function AppMenuGlass({
  actions,
  onSelectIndex,
  children,
  accessibilityLabel,
  accessibilityHint,
  style,
}: AppMenuProps) {
  // iOS draws a native checkmark from `selected`; the Android dropdown does not,
  // so prefix the active row there (the one spot the glass variant needs it).
  const menuActions: ContextMenuAction[] = actions.map((action) => ({
    title: Platform.OS === 'ios' ? action.label : action.selected ? `✓  ${action.label}` : action.label,
    selected: action.selected,
    destructive: action.destructive,
    // SF Symbol shown by the native iOS dropdown (forwarded so it isn't dropped).
    systemIcon: action.systemIcon,
  }));
  return (
    <ContextMenu
      dropdownMenuMode
      actions={menuActions}
      onPress={(event) => onSelectIndex(event.nativeEvent.index)}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      {children}
    </ContextMenu>
  );
}

function AppMenuMaterial({
  actions,
  onSelectIndex,
  children,
  accessibilityLabel,
  accessibilityHint,
  style,
}: AppMenuProps) {
  const { m3 } = useTheme();
  const [visible, setVisible] = useState(false);
  return (
    <Menu
      visible={visible}
      onDismiss={() => setVisible(false)}
      anchor={
        <Pressable
          onPress={() => setVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          style={style}
        >
          {children}
        </Pressable>
      }
    >
      {actions.map((action, index) => (
        <Menu.Item
          // Composite key: scope entries can share a display name (two gyms named the
          // same), so the label alone isn't unique — pair it with the position.
          key={`${index}-${action.label}`}
          title={action.label}
          leadingIcon={action.selected ? 'check' : undefined}
          titleStyle={action.destructive ? { color: m3.error } : undefined}
          onPress={() => {
            setVisible(false);
            onSelectIndex(index);
          }}
        />
      ))}
    </Menu>
  );
}
