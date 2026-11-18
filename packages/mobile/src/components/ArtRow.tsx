import { memo, useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { insetGroupedRowStyles } from './InsetGroupedList';
import { ART_SLOTS, ROW_ART_GAP, ROW_GUTTER, type ArtSize } from './art-slot';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

/**
 * A built-in accessory, or an element of your own (a ⋯ menu button). An element
 * is drawn beside the row's pressable, not inside it, so VoiceOver and TalkBack
 * focus it on its own and a tap on it never presses the row.
 */
export type ArtRowAccessory = 'checkmark' | 'chevron' | ReactElement;

/**
 * The title's type, and the spacing that goes with it. `headline` (the
 * default) is a shelf's row on Home: the name in headline, 12pt above and below,
 * 4pt to the subtitle. `body` is a list to choose from, the board picker's: the
 * name in body, regular until the row is selected (then its emphasized weight),
 * 10pt above and below and 2pt to the subtitle, a system list's spacing.
 */
export type ArtRowTitleVariant = 'headline' | 'body';

export type ArtRowProps = {
  /**
   * The leading art: a `BoardThumbnail`, a playlist tile, an icon. Hidden from
   * VoiceOver. Memoise it (`useMemo`) in the caller: a fresh element on every
   * render defeats this row's `memo`.
   */
  art: ReactNode;
  /** The slot's width (36, 44 or 72pt) and the matching separator inset. The art sets the row's height. */
  artSize: ArtSize;
  title: string;
  /** See `ArtRowTitleVariant`. Defaults to `headline`. */
  titleVariant?: ArtRowTitleVariant;
  /** A string is set in subheadline, secondary label. Pass a node to compose your own line. */
  subtitle?: ReactNode;
  /** A footnote line above the title, in secondary label. */
  eyebrow?: string;
  /**
   * A `StatusPill` beside the title. It never shrinks: when the two don't fit on
   * one line, the pill drops under the title.
   */
  status?: ReactNode;
  /**
   * `chevron` opens something, `checkmark` marks the selected row of a choice
   * (it holds its width on unselected rows, so titles don't jump), or an element.
   */
  accessory?: ArtRowAccessory;
  /** The current or chosen item: the selection wash, the title at its emphasized weight, the checkmark. */
  selected?: boolean;
  onPress?: () => void;
  /** Also published as the row's `longpress` accessibility action. */
  onLongPress?: () => void;
  delayLongPress?: number;
  /**
   * What the long press does, for screen readers ("Board actions"). VoiceOver
   * lists the action only with a label (it would read out the raw name without
   * one); TalkBack has its own "long press" wording.
   */
  longPressAccessibilityLabel?: string;
  /** Without it, VoiceOver reads the row's text in order. */
  accessibilityLabel?: string;
  /**
   * More actions for screen readers, published after the long press: a ⋯
   * menu's rows, so VoiceOver reaches them from the row itself. Memoise it.
   */
  accessibilityActions?: readonly AccessibilityActionInfo[];
  /** Runs one of `accessibilityActions`; the long press is handled here already. */
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  /**
   * Wraps the row's own target (art, text and a built-in accessory), never an
   * element accessory: a hold menu's anchor goes here, so the ⋯ beside it keeps
   * its own tap and isn't lifted with the row. Give the wrapper `flex: 1` when
   * there is an element accessory. Memoise it (`useCallback`).
   */
  wrapTarget?: (target: ReactElement) => ReactElement;
  testID?: string;
};

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
/** The checkmark on unselected rows: laid out, never drawn, so every title starts at the same x. */
const HIDDEN_CHECKMARK = { opacity: 0 } as const;

const artSlotStyles = StyleSheet.create({
  compact: { width: ART_SLOTS.compact.width, flexShrink: 0, alignItems: 'center' },
  regular: { width: ART_SLOTS.regular.width, flexShrink: 0, alignItems: 'center' },
  large: { width: ART_SLOTS.large.width, flexShrink: 0, alignItems: 'center' },
});

/** `titleVariant="body"`: a list's spacing, tighter than a shelf's (`insetGroupedRowStyles`). */
const listStyles = StyleSheet.create({
  padding: { paddingVertical: 10 },
  text: { gap: 2 },
});
const LIST_TEXT = [insetGroupedRowStyles.text, listStyles.text];

/**
 * A row of an `InsetGroupedList` that leads with art: a board, a playlist, a
 * session. Title in headline (or body, `titleVariant`), an optional eyebrow
 * above it and subtitle below, a status pill beside it, and a chevron, a
 * checkmark or a control at the end.
 *
 * Selection is a state, not a link, so a selected row's text is never violet: it
 * takes `theme.selection` (the brand wash behind the row, the label-coloured
 * title at its emphasized weight, an accent checkmark) and reports `selected` to
 * VoiceOver and TalkBack. Press feedback is an opacity dip, never a scale, so a
 * row inside a card doesn't shrink away from its neighbours.
 */
export const ArtRow = memo(function ArtRow({
  art,
  artSize,
  title,
  titleVariant = 'headline',
  subtitle,
  eyebrow,
  status,
  accessory,
  selected = false,
  onPress,
  onLongPress,
  delayLongPress,
  longPressAccessibilityLabel,
  accessibilityLabel,
  accessibilityActions: extraAccessibilityActions,
  onAccessibilityAction,
  wrapTarget,
  testID,
}: ArtRowProps) {
  const { systemColors, selection } = useTheme();
  const selectedFill = selection.fill;
  // A built-in accessory is decoration inside the row's target. An element (a ⋯
  // button) is a control of its own, so it is drawn beside the target.
  const elementAccessory = accessory !== undefined && accessory !== 'chevron' && accessory !== 'checkmark';
  const listSpacing = titleVariant === 'body';
  const { rowStyle, targetStyle } = useMemo(() => {
    // Beside a control the target holds the vertical padding, not the row.
    const paddedTarget = listSpacing ? [styles.targetBesideControl, listStyles.padding] : styles.targetBesideControl;
    const plainRow = listSpacing ? [insetGroupedRowStyles.row, listStyles.padding] : insetGroupedRowStyles.row;
    const base = elementAccessory ? styles.rowWithControl : plainRow;
    const row = selected ? [base, { backgroundColor: selectedFill }] : base;
    return { rowStyle: row, targetStyle: elementAccessory ? paddedTarget : row };
  }, [elementAccessory, listSpacing, selected, selectedFill]);
  // A row in a choice says "not selected" too; any other row says nothing.
  const accessibilityState = selected ? SELECTED_STATE : accessory === 'checkmark' ? UNSELECTED_STATE : undefined;
  const hasLongPress = onLongPress !== undefined;
  const accessibilityActions = useMemo(() => {
    const longPress: AccessibilityActionInfo[] =
      hasLongPress && (Platform.OS === 'android' || longPressAccessibilityLabel)
        ? [{ name: 'longpress', label: longPressAccessibilityLabel }]
        : [];
    const actions = [...longPress, ...(extraAccessibilityActions ?? [])];
    return actions.length > 0 ? actions : undefined;
  }, [hasLongPress, longPressAccessibilityLabel, extraAccessibilityActions]);
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') onLongPress?.();
      else onAccessibilityAction?.(event);
    },
    [onLongPress, onAccessibilityAction],
  );

  const titleText = (
    <Text
      variant={titleVariant}
      emphasized={selected}
      color={selected ? selection.text : undefined}
      numberOfLines={status ? 2 : undefined}
      style={status ? styles.titleBesideStatus : undefined}
    >
      {title}
    </Text>
  );

  const content = (
    <>
      <View style={artSlotStyles[artSize]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {art}
      </View>
      <View style={listSpacing ? LIST_TEXT : insetGroupedRowStyles.text}>
        {eyebrow ? (
          <Text variant="footnote" tone="secondary">
            {eyebrow}
          </Text>
        ) : null}
        {status ? (
          <View style={styles.titleLine}>
            {titleText}
            {status}
          </View>
        ) : (
          titleText
        )}
        {typeof subtitle === 'string' || typeof subtitle === 'number' ? (
          <Text variant="subheadline" tone="secondary">
            {subtitle}
          </Text>
        ) : (
          (subtitle ?? null)
        )}
      </View>
      {accessory === 'chevron' ? (
        <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
      ) : accessory === 'checkmark' ? (
        <View style={selected ? undefined : HIDDEN_CHECKMARK}>
          <Icon name="check.small" size={17} color={selection.checkmark} />
        </View>
      ) : null}
    </>
  );

  const target =
    onPress || onLongPress ? (
      <PressableSurface
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        feedback="opacity"
        rippleColor={systemColors.label as string}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
        style={targetStyle}
        testID={testID}
      >
        {content}
      </PressableSurface>
    ) : (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        style={targetStyle}
        testID={testID}
      >
        {content}
      </View>
    );

  const wrappedTarget = wrapTarget ? wrapTarget(target) : target;
  if (!elementAccessory) return wrappedTarget;
  // The same box as a plain row: the target keeps the leading gutter and the
  // vertical padding, the control takes the gap before it and the trailing
  // gutter after it, and the selection wash spans both.
  return (
    <View style={rowStyle}>
      {wrappedTarget}
      <View style={styles.control}>{accessory}</View>
    </View>
  );
});

const styles = StyleSheet.create({
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    // When the title and the pill don't fit on one line (a long name, or an
    // accessibility text size), the pill drops under the title instead of
    // squeezing it to a few characters.
    flexWrap: 'wrap',
    columnGap: spacing[2],
    rowGap: spacing[1],
  },
  titleBesideStatus: {
    flexShrink: 1,
  },
  /** The outer row when a control sits at the end: the trailing gutter only. */
  rowWithControl: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: ROW_ART_GAP,
    paddingEnd: ROW_GUTTER,
  },
  /** The row's own target beside a control: the leading gutter, the vertical padding, the minimum height. */
  targetBesideControl: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_ART_GAP,
    paddingStart: ROW_GUTTER,
    paddingVertical: spacing[3],
    minHeight: spacing[12],
  },
  control: {
    justifyContent: 'center',
  },
});
