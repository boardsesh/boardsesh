import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { SectionDisclosureChevron } from './SectionDisclosureChevron';
import { useTheme } from '../providers/theme-provider';
import { sectionHeaderText } from './section-header-text';
import { applySectionCaption } from '../theme/variants/variant-tokens';
import { spacing } from '../theme/tokens';

/**
 * Makes a section header a disclosure. One object rather than two loose props:
 * `expanded` without a toggle renders a section nobody can open, and a toggle
 * without `expanded` has nothing to drive the chevron — bundling them makes
 * that half-specified state unrepresentable instead of silently wrong.
 */
export type SectionDisclosure = {
  expanded: boolean;
  onToggle: () => void;
};

type SectionHeaderProps = {
  title: string;
  /** Trailing affordance label (e.g. "See all"). Renders a tappable action on
   *  the right of the header when paired with `onActionPress`. */
  actionLabel?: string;
  onActionPress?: () => void;
  /** Omit for a plain, non-collapsible header. */
  disclosure?: SectionDisclosure;
};

export function SectionHeader({ title, actionLabel, onActionPress, disclosure }: SectionHeaderProps) {
  const { brandColors, systemColors, variant, m3, sectionCaption } = useTheme();
  // Both variants are sentence case. Liquid Glass is footnote semibold in
  // secondaryLabel, matching the native SwiftUI Form headers in Settings (HIG
  // Lists and tables); Material is titleSmall in onSurfaceVariant (M3 lists).
  // Case, opacity and tracking come from `sectionCaption`; the Text scale,
  // colour and weight from `sectionHeaderText`.
  const caption = applySectionCaption(title, sectionCaption);
  const headerText = sectionHeaderText(variant, {
    secondaryLabel: systemColors.secondaryLabel,
    onSurfaceVariant: m3.onSurfaceVariant,
  });
  const showAction = !!actionLabel && !!onActionPress;
  const collapsible = disclosure !== undefined;

  const titleText = (
    <Text
      variant={headerText.textVariant}
      color={headerText.color}
      style={[caption.style, { fontWeight: headerText.fontWeight }]}
    >
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
          onPress={disclosure.onToggle}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          // The raw title, not the uppercased caption, so VoiceOver/TalkBack
          // don't spell it out letter by letter.
          accessibilityLabel={title}
          accessibilityState={{ expanded: disclosure.expanded }}
          style={styles.disclosure}
        >
          {titleText}
          <SectionDisclosureChevron expanded={disclosure.expanded} size={14} />
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
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    // Takes the row's spare width so the whole heading toggles, not just the
    // glyphs. Any action ("See all") still keeps its own space on the right.
    flex: 1,
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
