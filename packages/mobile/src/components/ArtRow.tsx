import { memo, useMemo, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { insetGroupedRowStyles } from './InsetGroupedList';
import { ART_SLOTS, type ArtSize } from './art-slot';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

/** A built-in accessory, or an element of your own (a ⋯ menu button). */
export type ArtRowAccessory = 'checkmark' | 'chevron' | ReactElement;

export type ArtRowProps = {
  /** The leading art: a `BoardThumbnail`, a playlist tile, an icon. Hidden from VoiceOver. */
  art: ReactNode;
  /** The slot's width (36 or 44pt) and the matching separator inset. The art sets the row's height. */
  artSize: ArtSize;
  title: string;
  /** A string is set in subheadline, secondary label. Pass a node to compose your own line. */
  subtitle?: ReactNode;
  /** A footnote line above the title, in secondary label. */
  eyebrow?: string;
  /** A `StatusPill` beside the title. It never shrinks; the title wraps or truncates first. */
  status?: ReactNode;
  /**
   * `chevron` opens something, `checkmark` marks the selected row of a choice
   * (it holds its width on unselected rows, so titles don't jump), or an element.
   */
  accessory?: ArtRowAccessory;
  /** The current or chosen item: the selection wash, the title at its emphasized weight, the checkmark. */
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  /** Without it, VoiceOver reads the row's text in order. */
  accessibilityLabel?: string;
  testID?: string;
};

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
/** The checkmark on unselected rows: laid out, never drawn, so every title starts at the same x. */
const HIDDEN_CHECKMARK = { opacity: 0 } as const;

const artSlotStyles = StyleSheet.create({
  compact: { width: ART_SLOTS.compact.width, flexShrink: 0, alignItems: 'center' },
  regular: { width: ART_SLOTS.regular.width, flexShrink: 0, alignItems: 'center' },
});

/**
 * A row of an `InsetGroupedList` that leads with art: a board, a playlist, a
 * session. Title in headline, an optional eyebrow above it and subtitle below,
 * a status pill beside it, and a chevron or checkmark at the end.
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
  subtitle,
  eyebrow,
  status,
  accessory,
  selected = false,
  onPress,
  onLongPress,
  delayLongPress,
  accessibilityLabel,
  testID,
}: ArtRowProps) {
  const { systemColors, selection } = useTheme();
  const selectedFill = selection.fill;
  const rowStyle = useMemo(
    () => (selected ? [insetGroupedRowStyles.row, { backgroundColor: selectedFill }] : insetGroupedRowStyles.row),
    [selected, selectedFill],
  );
  // A row in a choice says "not selected" too; any other row says nothing.
  const accessibilityState = selected ? SELECTED_STATE : accessory === 'checkmark' ? UNSELECTED_STATE : undefined;

  const titleText = (
    <Text
      variant="headline"
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
      <View style={insetGroupedRowStyles.text}>
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
      ) : (
        (accessory ?? null)
      )}
    </>
  );

  if (onPress || onLongPress) {
    return (
      <PressableSurface
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        feedback="opacity"
        rippleColor={systemColors.label as string}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        style={rowStyle}
        testID={testID}
      >
        {content}
      </PressableSurface>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      style={rowStyle}
      testID={testID}
    >
      {content}
    </View>
  );
});

const styles = StyleSheet.create({
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  titleBesideStatus: {
    flexShrink: 1,
  },
});
