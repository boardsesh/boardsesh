import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { SectionDisclosureChevron } from './SectionDisclosureChevron';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { applySectionCaption } from '../theme/variants/variant-tokens';
import { spacing } from '../theme/tokens';

type SectionHeaderProps = {
  title: string;
  /** Trailing affordance label (e.g. "See all"). Renders a tappable action on
   *  the right of the header when paired with `onActionPress`. */
  actionLabel?: string;
  onActionPress?: () => void;
  /** Current disclosure state. Paired with `onToggleExpanded`, turns the title
   *  into a tappable disclosure with a rotating chevron. The action (if any)
   *  stays a separate sibling target, so "See all" never toggles the section. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
};

export function SectionHeader({ title, actionLabel, onActionPress, expanded, onToggleExpanded }: SectionHeaderProps) {
  const { brandColors, variant, m3, sectionCaption } = useTheme();
  // M3 list/section headers are sentence-case titleSmall in onSurfaceVariant — not
  // the iOS group caption (uppercased, dimmed, tracked-out footnote). The uppercase
  // + 0.6 opacity + letter-spacing come from `sectionCaption` (keyed on variant, not
  // Platform.OS — a Liquid-Glass user on Android must still get the HIG caption); the
  // Text scale, colour, and weight stay per-variant here.
  const caption = applySectionCaption(title, sectionCaption);
  const textVariant = selectByVariant(variant, { liquidGlass: 'footnote', material: 'subheadline' } as const);
  const textColor = selectByVariant(variant, { liquidGlass: undefined, material: m3.onSurfaceVariant });
  const weightStyle = selectByVariant(variant, { liquidGlass: undefined, material: styles.materialText });
  const showAction = !!actionLabel && !!onActionPress;
  const collapsible = expanded !== undefined && !!onToggleExpanded;

  const titleText = (
    <Text variant={textVariant} color={textColor} style={[caption.style, weightStyle]}>
      {caption.text}
    </Text>
  );

  return (
    <View style={[styles.container, (showAction || collapsible) && styles.containerWithAction]}>
      {collapsible ? (
        // Only the title + chevron cluster is tappable — keeping the action a
        // sibling rather than nesting it inside this pressable avoids the
        // nested-touch ambiguity that bites on Android.
        <PressableSurface
          onPress={onToggleExpanded}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          // The raw title, not the uppercased caption, so VoiceOver/TalkBack
          // don't spell it out letter by letter.
          accessibilityLabel={title}
          accessibilityState={{ expanded }}
          style={styles.disclosure}
        >
          {titleText}
          <SectionDisclosureChevron expanded={expanded} size={14} />
        </PressableSurface>
      ) : (
        titleText
      )}
      {showAction ? (
        <PressableSurface
          onPress={onActionPress}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={styles.action}
        >
          <Text variant="footnote" color={brandColors.primary} style={styles.actionText}>
            {actionLabel}
          </Text>
          <Icon name="chevron.right" size={12} color={brandColors.primary} />
        </PressableSurface>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[6],
    paddingBottom: spacing[2],
  },
  containerWithAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // M3 titleSmall weight (the `subheadline` material scale is 14/400; titleSmall
  // is 14/500). Opacity / letter-spacing come from `caption.style` per variant;
  // onSurfaceVariant carries the hierarchy on Material.
  materialText: {
    fontWeight: '500',
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    flexShrink: 1,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  actionText: {
    fontWeight: '600',
  },
});
