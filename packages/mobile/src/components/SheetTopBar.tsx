// The one top bar for a sheet's actions: leading Cancel / close / back, a
// centred title, and a trailing confirm. Passed through `ModalSheet` / `Sheet`'s
// `header` slot, which sits above the body and outside its scroll, so the bar
// never moves with the keyboard, the bottom inset or error text. See
// docs/mobile-sheets-vs-routes.md, "Where actions go".
//
// Generalised from TickSheetHeader, which keeps its own grade-bar design.
//
// Layout without measuring. The two flanks share what the title leaves over in
// equal halves (`flexGrow: 1`, `flexBasis: 0`), so the title is centred on the
// first frame with no onLayout round trip that could shift it. The title is
// capped at half the row, so a long title truncates instead of squeezing the
// actions off the bar.
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../theme/typography';
import { glassSize } from '../theme/layout';

/** Every tappable thing in the bar is at least this big (HIG and M3 both say 44+). */
export const SHEET_TOP_BAR_TARGET = 44;

/** The bar's own height, so a sheet can budget for it. */
export const SHEET_TOP_BAR_HEIGHT = 56;

/** The size of the leading glyphs. */
const GLYPH_SIZE = 18;

export type SheetTopBarLeading = {
  /**
   * `cancel` is the word "Cancel" (a form that throws edits away), `close` an X
   * in a filled disc (a sheet with nothing to lose), `back` a chevron (step two
   * onward of a multi-step sheet).
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
  /** The sheet's confirm: a filled brand capsule instead of a plain label. */
  prominent?: boolean;
  accessibilityLabel?: string;
};

type SheetTopBarProps = {
  title: string;
  subtitle?: string;
  leading?: SheetTopBarLeading;
  trailing?: SheetTopBarTrailing;
  /** Shown in a slot under the bar. */
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
  const { systemColors, brandColors, radii, spacing } = useTheme();
  const inert = disabled || loading;
  const handlePress = useCallback(() => {
    if (!inert) onPress();
  }, [inert, onPress]);

  // `radii.button` is already resolved per UI variant (Liquid Glass vs Material),
  // so the capsule follows the active design language without a branch here. It
  // stays a solid brand fill on both: the same rule as Button's filled CTA, which
  // never goes translucent.
  const labelColor = prominent ? brandColors.onPrimary : disabled ? systemColors.tertiaryLabel : brandColors.primary;
  const surface = prominent
    ? [
        styles.prominent,
        {
          backgroundColor: brandColors.primary,
          borderRadius: radii.button,
          paddingHorizontal: spacing[4],
        },
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
          style={[styles.trailingLabel, loading ? styles.hidden : null]}
        >
          {label}
        </Text>
        {loading ? (
          <View style={styles.spinner} testID="sheet-top-bar-spinner">
            <ActivityIndicator size="small" color={prominent ? brandColors.onPrimary : undefined} />
          </View>
        ) : null}
      </View>
    </PressableSurface>
  );
});

export const SheetTopBar = React.memo(function SheetTopBar({
  title,
  subtitle,
  leading,
  trailing,
  error,
  reserveErrorSlot = false,
  testID,
}: SheetTopBarProps) {
  const { systemColors, brandColors, spacing, textStyles } = useTheme();
  // One footnote line plus its padding: the slot is the same height with and
  // without an error, so reserving it means nothing below ever moves.
  const errorSlotHeight = (textStyles.footnote.lineHeight ?? 0) + spacing[1] * 2;
  const showErrorSlot = reserveErrorSlot || Boolean(error);

  return (
    <View testID={testID}>
      <View
        style={[
          styles.bar,
          { paddingHorizontal: spacing[4], gap: spacing[2], borderBottomColor: systemColors.separator },
        ]}
      >
        <View style={[styles.flank, styles.flankLeading]}>
          {leading ? <SheetTopBarLeadingButton {...leading} /> : null}
        </View>
        <View style={styles.titles}>
          <Text variant="headline" numberOfLines={1} accessibilityRole="header" style={styles.centredText}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.centredText}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={[styles.flank, styles.flankTrailing]}>
          {trailing ? <SheetTopBarTrailingButton {...trailing} /> : null}
        </View>
      </View>
      {showErrorSlot ? (
        <View
          testID="sheet-top-bar-error-slot"
          style={[
            styles.errorSlot,
            { minHeight: errorSlotHeight, paddingHorizontal: spacing[4], paddingVertical: spacing[1] },
          ]}
        >
          {error ? (
            <Text
              variant="footnote"
              color={brandColors.error}
              numberOfLines={2}
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
  // Equal halves of whatever the title leaves. Basis 0 makes the two grow from
  // the same start, which is what centres the title without a measure pass.
  flank: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: SHEET_TOP_BAR_TARGET,
  },
  flankLeading: {
    alignItems: 'flex-start',
  },
  flankTrailing: {
    alignItems: 'flex-end',
  },
  titles: {
    flexShrink: 1,
    maxWidth: '50%',
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
  trailingLabel: {
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
  },
});
