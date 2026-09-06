import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import { hapticSelection } from '../lib/haptics';
import { getSectionExpandedSync, setSectionExpanded, useSectionExpanded } from '../lib/section-expand-store';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing, borderRadius } from '../theme/tokens';
import { timing } from '../theme/animations';

type CollapsibleSectionProps = {
  title: string;
  defaultExpanded?: boolean;
  /**
   * When true the section header has no chevron and cannot be collapsed by
   * the user. Mirrors the web `keepExpanded` flag used for hero sections
   * (e.g. Beta Videos) where users should always see the content.
   */
  keepExpanded?: boolean;
  /** Short text shown next to the title when the section is collapsed (e.g. active filter values). */
  summary?: string | null;
  /** When this value changes, expanded state resets to `defaultExpanded` without remounting the tree. */
  resetKey?: number;
  /** Optional trailing action rendered in the header (e.g. an Attach button). */
  headerAction?: ReactNode;
  /** Fires with the measured height of the header row whenever layout settles. */
  onHeaderLayout?: (height: number) => void;
  /** Fires when the section expands/collapses (and once on mount). Lets a caller
   *  gate expensive content (e.g. a query) on the section being open. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Fires only on a user tap that toggles the section — not on mount or a
   *  persisted-state reconciliation — with the new expanded state. Lets a host
   *  react to a deliberate expand (e.g. scroll the section into view). */
  onToggle?: (expanded: boolean) => void;
  /** When set, the section's expand state persists under this key (across climbs
   *  and app restarts) instead of resetting to `defaultExpanded` each mount.
   *  `defaultExpanded` is then only the first-ever state before the user touches
   *  the section. Omit to keep the section's state ephemeral. */
  persistKey?: string;
  children: ReactNode;
};

export function CollapsibleSection({
  title,
  defaultExpanded = false,
  keepExpanded = false,
  summary,
  resetKey,
  headerAction,
  onHeaderLayout,
  onExpandedChange,
  onToggle,
  persistKey,
  children,
}: CollapsibleSectionProps) {
  const handleHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeaderLayout?.(event.nativeEvent.layout.height);
    },
    [onHeaderLayout],
  );

  if (keepExpanded) {
    return (
      <View style={styles.container}>
        <View style={styles.header} onLayout={onHeaderLayout ? handleHeaderLayout : undefined}>
          <Text variant="headline" style={styles.title}>
            {title}
          </Text>
          {headerAction}
        </View>
        <View style={styles.content}>{children}</View>
      </View>
    );
  }

  return (
    <CollapsibleSectionInternal
      title={title}
      defaultExpanded={defaultExpanded}
      summary={summary}
      resetKey={resetKey}
      headerAction={headerAction}
      onHeaderLayoutEvent={onHeaderLayout ? handleHeaderLayout : undefined}
      onExpandedChange={onExpandedChange}
      onToggle={onToggle}
      persistKey={persistKey}
    >
      {children}
    </CollapsibleSectionInternal>
  );
}

function CollapsibleSectionInternal({
  title,
  defaultExpanded,
  summary,
  resetKey,
  headerAction,
  onHeaderLayoutEvent,
  onExpandedChange,
  onToggle,
  persistKey,
  children,
}: {
  title: string;
  defaultExpanded: boolean;
  summary?: string | null;
  resetKey?: number;
  headerAction?: ReactNode;
  // Internal prop takes the raw LayoutChangeEvent; the public `onHeaderLayout`
  // exposes just the measured height. Distinct names so the two signatures
  // never get conflated in callers or refactors.
  onHeaderLayoutEvent?: (event: LayoutChangeEvent) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onToggle?: (expanded: boolean) => void;
  persistKey?: string;
  children: ReactNode;
}) {
  // Seed from the persisted store synchronously when warm (no flash on the next
  // climb); fall back to `defaultExpanded` for a cold store or no persistKey.
  const initialExpanded = persistKey ? (getSectionExpandedSync(persistKey) ?? defaultExpanded) : defaultExpanded;
  const [expanded, setExpanded] = useState(initialExpanded);
  const chevronRotation = useSharedValue(initialExpanded ? 1 : 0);

  // Subscribe to the persisted value so a cold-launch async load (or an external
  // change to the same key) reconciles into local state.
  const { expanded: persistedExpanded } = useSectionExpanded(persistKey);
  useEffect(() => {
    // Keep the Reanimated side-effect out of the setState updater: StrictMode
    // double-invokes updaters in dev, which would fire withTiming twice.
    if (!persistKey || persistedExpanded === undefined || persistedExpanded === expanded) return;
    chevronRotation.value = withTiming(persistedExpanded ? 1 : 0, { duration: timing.normal });
    setExpanded(persistedExpanded);
  }, [persistKey, persistedExpanded, expanded, chevronRotation]);

  const isFirstReset = useRef(true);
  useEffect(() => {
    if (isFirstReset.current) {
      isFirstReset.current = false;
      return;
    }
    // A persisted section ignores resetKey — its remembered state outranks the
    // per-mount default that resetKey would otherwise restore.
    if (persistKey) return;
    setExpanded(defaultExpanded);
    chevronRotation.value = withTiming(defaultExpanded ? 1 : 0, { duration: timing.normal });
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report expand/collapse (and the initial state) so a caller can gate
  // expensive content — e.g. defer a drafts query until the section opens.
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  const toggleExpanded = useCallback(() => {
    // Side-effects (haptic, animation, persist) stay outside setExpanded so a
    // StrictMode double-invoke of the updater can't fire them twice. `expanded`
    // is in deps, so this closure is never stale.
    const next = !expanded;
    hapticSelection();
    chevronRotation.value = withTiming(next ? 1 : 0, { duration: timing.normal });
    if (persistKey) setSectionExpanded(persistKey, next);
    setExpanded(next);
    // User-intent signal (distinct from onExpandedChange, which also fires on
    // mount / persisted reconciliation) — lets a host scroll a deliberate expand
    // into view.
    onToggle?.(next);
  }, [expanded, chevronRotation, persistKey, onToggle]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
  }));

  return (
    <View style={styles.container}>
      {/* `headerAction` sits BETWEEN two toggle targets rather than inside one.
          Nesting it in the header pressable would leave its taps arbitrated by
          the responder system; as a sibling it simply owns them, so the Beta
          Videos "+" can never fold the section by accident. Visual order (title
          … action, chevron) is unchanged. */}
      <View style={styles.header} onLayout={onHeaderLayoutEvent}>
        <Pressable
          onPress={toggleExpanded}
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded }}
          style={styles.headerPress}
        >
          <Text variant="headline" style={styles.title}>
            {title}
          </Text>
          {!expanded && summary ? (
            <Text variant="footnote" style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </Pressable>
        {headerAction}
        <Pressable
          onPress={toggleExpanded}
          // The title pressable above already announces the section and its
          // expanded state; a second identical button would just be noise.
          // Hidden from a11y means it has no accessible name, so tests reach it
          // by testID rather than by role+name.
          accessibilityElementsHidden
          importantForAccessibility="no"
          testID="collapsible-section-chevron"
          hitSlop={8}
        >
          <Animated.View style={chevronStyle}>
            <Icon name="chevron.down" size={16} color={iosSystemColors.systemGray} />
          </Animated.View>
        </Pressable>
      </View>

      {/* Plain View, not a FadeIn/FadeOut Animated.View: inside a FlashList header
          the iOS entering animation settles at ~0 height and paints the body blank. */}
      {expanded && <View style={styles.content}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: borderRadius.lg,
    backgroundColor: `${iosSystemColors.systemGray}14`,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  // Takes the row's spare width so the title, the summary, and the dead space
  // between them all toggle the section — only the action is carved out.
  headerPress: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Sized by its own text (basis auto), shrinking only once the summary has
  // nothing left to give. `flex: 1` here is what broke the collapsed Logbook
  // header: it sets flexBasis 0, so a summary wider than the row put the row
  // into negative free space, which Yoga distributes by (shrink factor x base
  // size) — the title's base being 0 meant it absorbed none of that shrink and
  // stayed 0 wide, wrapping "Logbook" one letter per line down the card.
  title: {
    flexShrink: 1,
  },
  // Takes the row's spare width instead of its own text width (basis 0), so a
  // long summary can never squeeze the title: it ellipsizes into whatever is
  // left over. Right-aligned to sit against the chevron, as when the title
  // still grew into the gap.
  summary: {
    opacity: 0.55,
    flexGrow: 1,
    flexBasis: 0,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: spacing[2],
    marginRight: spacing[2],
  },
  content: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
});
