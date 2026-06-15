// The Home feed's scope control: a glass header pill showing the active scope
// ("My crew" / a gym name / "Everyone") with a down-caret. Tapping it opens a
// native iOS menu (UIMenu via react-native-context-menu-view's dropdown mode) to
// switch scope / pick a gym — a HIG title-menu button in the floating chrome
// rather than a large in-body title.

import { Platform, StyleSheet, View, type NativeSyntheticEvent } from 'react-native';
import ContextMenu, {
  type ContextMenuAction,
  type ContextMenuOnPressNativeEvent,
} from 'react-native-context-menu-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing, shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { useTheme } from '../../providers/theme-provider';

const PILL_HEIGHT = glassSize.capsule;
const PILL_RADIUS = PILL_HEIGHT / 2;

type FeedScopeTitleProps = {
  /** The active scope, shown in the pill. */
  title: string;
  /** Menu items, in render order; `onSelectIndex` is called with the tapped index. */
  actions: ContextMenuAction[];
  onSelectIndex: (index: number) => void;
  /** VoiceOver hint — the pill is a menu, so cue what activating it does. */
  accessibilityHint?: string;
};

export function FeedScopeTitle({ title, actions, onSelectIndex, accessibilityHint }: FeedScopeTitleProps) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  // `selected` (the checkmark) and `systemIcon` only render on iOS; on Android
  // the menu is title-only, so the active scope would have no marker. Prefix the
  // selected action's title with a checkmark glyph instead. The array order is
  // untouched, so `onSelectIndex` still maps each item back to its source index.
  const menuActions =
    Platform.OS === 'ios'
      ? actions
      : actions.map((action) => (action.selected ? { ...action, title: `✓  ${action.title}` } : action));
  return (
    <ContextMenu
      dropdownMenuMode
      actions={menuActions}
      onPress={(event: NativeSyntheticEvent<ContextMenuOnPressNativeEvent>) => onSelectIndex(event.nativeEvent.index)}
      style={styles.menu}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={accessibilityHint}
        style={[
          styles.pill,
          !nativeGlass && shadows.sm,
          !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
        ]}
      >
        {/* `clear` (lighter, content-forward) so the floating pill reads as a
            translucent control rather than frosted chrome. */}
        <GlassSurface
          glassEffectStyle="clear"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={PILL_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <Text variant="headline" color={systemColors.label} numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
      </View>
    </ContextMenu>
  );
}

const styles = StyleSheet.create({
  // Size the anchor to its content so the tap target is the pill.
  menu: { alignSelf: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    height: PILL_HEIGHT,
    borderRadius: PILL_RADIUS,
    paddingHorizontal: spacing[4],
    overflow: 'hidden',
    maxWidth: 240,
  },
  title: { fontWeight: '700', flexShrink: 1 },
});
