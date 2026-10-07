// The one top bar for a sheet's actions: leading Cancel / close / back, a
// centred title, and a trailing confirm. Passed through `ModalSheet` / `Sheet`'s
// `header` slot, which sits above the body and outside its scroll, so the bar
// never moves with the keyboard, the bottom inset or error text. See
// docs/mobile-sheets-vs-routes.md, "Where actions go".
//
// Generalised from TickSheetHeader, which keeps its own grade-bar design.
//
// The title yields, the actions never do (HIG). Both flanks keep their natural
// width (`flexShrink: 0`) and the title takes what is left, truncating when it
// runs out. To centre the title while there is room, a spacer on the narrower
// flank's side makes up the difference between the two measured flank widths.
// The spacer gives way first when room runs short, so a long title goes
// off-centre before it truncates. Only the title can move when the flanks
// measure; the actions sit at the edges from the first frame.
import React, { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../theme/typography';
import { glassSize } from '../theme/layout';

/** Every tappable thing in the bar is at least this big (HIG and M3 both say 44+). */
export const SHEET_TOP_BAR_TARGET = 44;

/** The bar's own height, so a sheet can budget for it. */
export const SHEET_TOP_BAR_HEIGHT = 56;

/** The size of the leading glyphs. */
const GLYPH_SIZE = 18;

/**
 * How the prominent confirm looks per design language. Liquid Glass: a filled
 * brand capsule. Material: brand-coloured semibold text with no fill, the
 * confirm of an M3 full-screen dialog's top app bar.
 */
const PROMINENT_FILLED = { liquidGlass: true, material: false } as const;

export type SheetTopBarLeading = {
  /**
   * `close` is an xmark in a filled disc: leaving loses nothing (the iOS 26
   * system sheets use it). `cancel` is the word "Cancel": leaving throws away an
   * edit. `back` is a chevron, for step two onward of a multi-step sheet.
   */
  kind: 'cancel' | 'close' | 'back';
  onPress: () => void;
  /** Overrides the default spoken label ("Cancel", "Close", "Back"). */
  accessibilityLabel?: string;
};

export type SheetTopBarTrailing = {
  label: string;
  onPress: () => void;
  /** Dims the action and swallows taps. */
  disabled?: boolean;
  /** A spinner stands in for the label, in the label's own space, and taps are swallowed. */
  loading?: boolean;
  /** The sheet's confirm. See PROMINENT_FILLED for how it looks. */
  prominent?: boolean;
  accessibilityLabel?: string;
};

type SheetTopBarProps = {
  title: string;
  subtitle?: string;
  leading?: SheetTopBarLeading;
  trailing?: SheetTopBarTrailing;
  /** Drawn before the trailing action, e.g. a "?" help button. */
  trailingAccessory?: ReactNode;
  /** Shown in a one-line slot under the bar. */
  error?: string | null;
  /**
   * Keep the error slot's height even while there is no error, so the body never
   * moves when one appears. Pass it for a sheet whose submit can fail.
   */
  reserveErrorSlot?: boolean;
  testID?: string;
};

const SheetTopBarLeadingButton = React.memo(function SheetTopBarLeadingButton({
  kind,
  onPress,
  accessibilityLabel,
}: SheetTopBarLeading) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();

  if (kind === 'cancel') {
    const label = t('actions.cancel');
    return (
      <PressableSurface
        testID="sheet-top-bar-leading"
        onPress={onPress}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={styles.textTarget}
      >
        <Text
          variant="body"
          color={brandColors.primary}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        >
          {label}
        </Text>
      </PressableSurface>
    );
  }

  const isClose = kind === 'close';
  return (
    <PressableSurface
      testID="sheet-top-bar-leading"
      onPress={onPress}
      feedback="opacity"
      rippleBorderless
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? t(isClose ? 'ariaLabels.close' : 'ariaLabels.back')}
      style={[styles.glyphTarget, isClose ? { backgroundColor: systemColors.fill } : null]}
    >
      <Icon
        name={isClose ? 'close' : 'back'}
        size={GLYPH_SIZE}
        color={isClose ? systemColors.secondaryLabel : brandColors.primary}
      />
    </PressableSurface>
  );
});

const SheetTopBarTrailingButton = React.memo(function SheetTopBarTrailingButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  prominent = false,
  accessibilityLabel,
}: SheetTopBarTrailing) {
  const { systemColors, brandColors, radii, spacing, variant } = useTheme();
  const inert = disabled || loading;
  const handlePress = useCallback(() => {
    if (!inert) onPress();
  }, [inert, onPress]);

  // `radii.button` is already resolved per UI variant. The capsule stays a
  // solid brand fill, the same rule as Button's filled CTA, which never goes
  // translucent.
  const filled = prominent && selectByVariant(variant, PROMINENT_FILLED);
  const labelColor = filled ? brandColors.onPrimary : disabled ? systemColors.tertiaryLabel : brandColors.primary;
  const surface = filled
    ? [
        styles.prominent,
        { backgroundColor: brandColors.primary, borderRadius: radii.button, paddingHorizontal: spacing[4] },
        disabled ? styles.dimmed : null,
      ]
    : null;

  return (
    <PressableSurface
      testID="sheet-top-bar-trailing"
      onPress={handlePress}
      disabled={inert}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={styles.textTarget}
    >
      <View style={surface}>
        {/* The label stays in the tree while loading, only hidden, so the slot
            keeps the label's width and nothing beside it moves. */}
        <Text
          variant="body"
          color={labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[prominent ? styles.prominentLabel : null, loading ? styles.hidden : null]}
        >
          {label}
        </Text>
        {loading ? (
          <View style={styles.spinner} testID="sheet-top-bar-spinner">
            <ActivityIndicator size="small" color={filled ? brandColors.onPrimary : undefined} />
          </View>
        ) : null}
      </View>
    </PressableSurface>
  );
});

/** Width of a measured view, rounded up so sub-pixel noise doesn't re-render. */
function useMeasuredWidth(): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setWidth((previous) => (previous === measured ? previous : measured));
  }, []);
  return [width, onLayout];
}

export const SheetTopBar = React.memo(function SheetTopBar({
  title,
  subtitle,
  leading,
  trailing,
  trailingAccessory,
  error,
  reserveErrorSlot = false,
  testID,
}: SheetTopBarProps) {
  const { systemColors, brandColors, spacing, textStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [leadingWidth, onLeadingLayout] = useMeasuredWidth();
  const [trailingWidth, onTrailingLayout] = useMeasuredWidth();

  // One line of footnote at the capped font scale, plus padding. The error text
  // is capped to the same scale and one line, so a long or scaled error can't
  // make the slot taller than what was reserved.
  const errorLineHeight = (textStyles.footnote.lineHeight ?? 0) * Math.min(fontScale, CHROME_LABEL_MAX_FONT_SCALE);
  const errorSlotHeight = Math.ceil(errorLineHeight) + spacing[1] * 2;
  const showErrorSlot = reserveErrorSlot || Boolean(error);

  return (
    <View testID={testID}>
      <View style={[styles.bar, { paddingHorizontal: spacing[4], borderBottomColor: systemColors.separator }]}>
        <View testID="sheet-top-bar-leading-flank" style={styles.flank} onLayout={onLeadingLayout}>
          {leading ? <SheetTopBarLeadingButton {...leading} /> : null}
        </View>
        <View style={[styles.balance, { width: Math.max(0, trailingWidth - leadingWidth) }]} />
        <View testID="sheet-top-bar-title" style={[styles.titles, { marginHorizontal: spacing[2] }]}>
          <Text variant="headline" numberOfLines={1} accessibilityRole="header" style={styles.centredText}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.centredText}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={[styles.balance, { width: Math.max(0, leadingWidth - trailingWidth) }]} />
        <View
          testID="sheet-top-bar-trailing-flank"
          style={[styles.flank, styles.trailingRow, { gap: spacing[2] }]}
          onLayout={onTrailingLayout}
        >
          {trailingAccessory}
          {trailing ? <SheetTopBarTrailingButton {...trailing} /> : null}
        </View>
      </View>
      {showErrorSlot ? (
        <View
          testID="sheet-top-bar-error-slot"
          style={[
            styles.errorSlot,
            { height: errorSlotHeight, paddingHorizontal: spacing[4], paddingVertical: spacing[1] },
          ]}
        >
          {error ? (
            <Text
              variant="footnote"
              color={brandColors.error}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: SHEET_TOP_BAR_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // The actions never shrink: the title gives way instead.
  flank: {
    flexShrink: 0,
    minWidth: SHEET_TOP_BAR_TARGET,
  },
  trailingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  // Centring spacer. Its huge shrink factor makes it give way before the title
  // does (Yoga shrinks by factor x basis).
  balance: {
    flexShrink: 1000,
  },
  titles: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  centredText: {
    textAlign: 'center',
  },
  textTarget: {
    minHeight: SHEET_TOP_BAR_TARGET,
    minWidth: SHEET_TOP_BAR_TARGET,
    justifyContent: 'center',
  },
  glyphTarget: {
    width: SHEET_TOP_BAR_TARGET,
    height: SHEET_TOP_BAR_TARGET,
    borderRadius: SHEET_TOP_BAR_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  prominent: {
    minHeight: glassSize.mini,
    justifyContent: 'center',
    alignItems: 'center',
  },
  prominentLabel: {
    fontWeight: '600',
  },
  hidden: {
    opacity: 0,
  },
  spinner: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmed: {
    opacity: 0.4,
  },
  errorSlot: {
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
