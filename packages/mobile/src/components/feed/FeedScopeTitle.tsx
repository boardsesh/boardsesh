// The Home feed's scope control, routed by UI variant. It shows the active scope
// ("My crew" / a gym name / "Everyone") with a down-caret and opens a dropdown menu
// to switch scope / pick a gym.
//
// Liquid Glass: a floating glass pill (the title-menu button that sits in the
// floating chrome). Material: the flat M3 app-bar title — leading-aligned, no pill
// background — that grows to fill the app bar's title slot (mirroring
// `BoardSwitcherButton`). Both open the same dropdown (a Paper menu on Material, the
// native iOS UIMenu on Liquid Glass) via `AppMenu`.

import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { createVariantComponent } from '../../theme/variants';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing, shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { useTheme } from '../../providers/theme-provider';

const PILL_HEIGHT = glassSize.capsule;
const PILL_RADIUS = PILL_HEIGHT / 2;

type FeedScopeTitleProps = {
  /** The active scope, shown in the pill / title. */
  title: string;
  /** Menu items, in render order; `onSelectIndex` is called with the tapped index. */
  actions: AppMenuAction[];
  onSelectIndex: (index: number) => void;
  /** VoiceOver hint — the control is a menu, so cue what activating it does. */
  accessibilityHint?: string;
};

export const FeedScopeTitle = createVariantComponent('FeedScopeTitle', {
  liquidGlass: FeedScopeTitleGlass,
  material: FeedScopeTitleMaterial,
});

function FeedScopeTitleGlass({ title, actions, onSelectIndex, accessibilityHint }: FeedScopeTitleProps) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  // `AppMenu` owns the per-variant menu (native dropdown) and the selected-row
  // marker; the actions are already in its neutral shape.
  return (
    <AppMenu
      actions={actions}
      onSelectIndex={onSelectIndex}
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      style={styles.menu}
    >
      <View
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
          // Floating scope pill = M3 surfaceContainer tone on Material.
          role="base"
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
    </AppMenu>
  );
}

function FeedScopeTitleMaterial({ title, actions, onSelectIndex, accessibilityHint }: FeedScopeTitleProps) {
  const { systemColors } = useTheme();
  // The flat M3 app-bar title (no pill): the menu anchor itself is the centered row
  // (filling the title slot, flex: 1), so the title + caret stay vertically centred
  // with the avatar / trailing action — mirroring `BoardSwitcherButton`.
  return (
    <AppMenu
      actions={actions}
      onSelectIndex={onSelectIndex}
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      style={styles.materialMenu}
    >
      <Text
        variant="title3"
        color={systemColors.label}
        numberOfLines={1}
        ellipsizeMode="tail"
        style={styles.materialTitle}
      >
        {title}
      </Text>
      <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
    </AppMenu>
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
  // Material: a leading, content-width menu anchor (Paper's Menu wraps it in a
  // content-width View, so flex: 1 here wouldn't reach the app-bar row). The host
  // right-aligns the trailing action with a flex spacer; `maxWidth` keeps a long
  // scope name from crowding it. The row centres the title + caret vertically.
  materialMenu: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    maxWidth: 220,
  },
  materialTitle: { fontWeight: '700', flexShrink: 1 },
});
