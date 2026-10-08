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
import type { IconName } from './icon-map';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import { ChromeIconButton } from './ChromeIconButton';
import { TopBarConfirmGlyph } from './TopBarConfirmGlyph';
import type { IconName } from './icon-map';
import {
  resolveTopBarActionLook,
  resolveTrailingKind,
  type TopBarActionColors,
  type TopBarTrailingKind,
} from './top-bar-action-look';
import { useTheme } from '../providers/theme-provider';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../theme/typography';
import { topBarFor } from '../theme/top-bar';

/** Every tappable thing in the bar is at least this big (HIG and M3 both say 44+). */
export const SHEET_TOP_BAR_TARGET = 44;

/** The bar's own height, so a sheet can budget for it. */
export const SHEET_TOP_BAR_HEIGHT = 56;

/** The glyph before a text action's label, sized to the label. */
const TRAILING_ICON_SIZE = 15;

/** The theme colours a top-bar action can take. */
function actionColors(
  systemColors: ReturnType<typeof useTheme>['systemColors'],
  brandColors: ReturnType<typeof useTheme>['brandColors'],
): TopBarActionColors {
  return {
    label: systemColors.label,
    primary: brandColors.primary,
    onPrimary: brandColors.onPrimary,
    error: brandColors.error,
  };
}

/** What every leading action has, whatever it draws. */
type SheetTopBarLeadingBase = {
  onPress: () => void;
  /** Overrides the default spoken label. */
  accessibilityLabel?: string;
  /** Dims the action and swallows taps, as on the trailing confirm. */
  disabled?: boolean;
};

/** The leading way out of a sheet or screen. */
export type SheetTopBarLeading = SheetTopBarLeadingBase & {
  /**
   * `close` is an xmark in a filled circle: leaving loses nothing (the iOS 26
   * system sheets use it). `cancel` is the word "Cancel": leaving throws away an
   * edit. `back` is a chevron, for step two onward of a multi-step sheet.
   */
  kind: 'cancel' | 'close' | 'back';
  /**
   * The word `cancel` shows instead of "Cancel", for a leading decline that is
   * still a way out: onboarding's "Not now" or "Skip for now". Ignored by the
   * glyphs.
   */
  label?: string;
};

/**
 * A secondary text action in the leading slot that is not a way out, e.g. a
 * filter sheet's "Reset" across from its Apply. Drawn like `cancel`, with its
 * own label. Sheets only: a screen's leading slot is its way back.
 */
export type SheetTopBarTextLeading = SheetTopBarLeadingBase & {
  kind: 'text';
  label: string;
};

export type SheetTopBarTrailing = {
  /** The visible word, or with the iOS ✓ only the spoken name. */
  label: string;
  /**
   * `confirm` saves or commits the climber's own edit (Save, Add, a Done that
   * commits a value): on iOS 26 a ✓ in a brand circle the size of the close, on
   * Material the word; destructive, it is red text, never a red ✓. `send` sends
   * or reports to someone else (Submit, Report, Claim): prominent text. `forward`
   * moves on, applies, or closes a confirmation (Next, Apply, a post-submit
   * Done): text. Unset, a `prominent` action is a confirm and any other a
   * forward; see `resolveTrailingKind`.
   */
  kind?: TopBarTrailingKind;
  onPress: () => void;
  /** Dims the action and swallows taps. */
  disabled?: boolean;
  /** A spinner stands in for the label, in the label's own space, and taps are swallowed. */
  loading?: boolean;
  /**
   * The sheet's confirm: a filled brand capsule on Liquid Glass, brand text on
   * Material. See `theme/top-bar.ts`.
   */
  prominent?: boolean;
  /**
   * The confirm ends or throws something away ("End session"). Drawn in the
   * error colour: the capsule's fill when prominent on Liquid Glass, otherwise
   * the label.
   */
  destructive?: boolean;
  /**
   * A glyph for a state the label alone can't carry (the create drawer's lock on
   * a climb past its edit window). On the iOS confirm it replaces the ✓; on a
   * text action it sits before the label.
   */
  icon?: IconName;
  accessibilityLabel?: string;
  /** Why the action is the way it is, e.g. why it is disabled. */
  accessibilityHint?: string;
};

type SheetTopBarProps = {
  title: string;
  subtitle?: string;
  leading?: SheetTopBarLeading | SheetTopBarTextLeading;
  trailing?: SheetTopBarTrailing;
  /** Drawn before the trailing action, e.g. a "?" help button. */
  trailingAccessory?: ReactNode;
  /**
   * Paints a 4x32 rounded bar before the title (the grade colour of a climb), as
   * TickSheetHeader does, and sets the title flush left beside it instead of
   * centred. `null` paints the bar in the separator tone, for an ungraded climb;
   * leave it undefined for no bar and a centred title.
   */
  accentColor?: string | null;
  /** Shown in a one-line slot under the bar. */
  error?: string | null;
  /**
   * Keep the error slot's height even while there is no error, so the body never
   * moves when one appears. Pass it for a sheet whose submit can fail.
   */
  reserveErrorSlot?: boolean;
  testID?: string;
};

const SheetTopBarLeadingButton = React.memo(function SheetTopBarLeadingButton(
  leading: SheetTopBarLeading | SheetTopBarTextLeading,
) {
  const { kind, onPress, accessibilityLabel, disabled = false } = leading;
  const { t } = useTranslation('common');
  const { systemColors, brandColors, variant } = useTheme();
  const spec = topBarFor(variant);

  if (leading.kind === 'cancel' || leading.kind === 'text') {
    const label = leading.label ?? t('actions.cancel');
    const look = resolveTopBarActionLook(spec, actionColors(systemColors, brandColors), { disabled, surface: 'sheet' });
    return (
      <PressableSurface
        testID="sheet-top-bar-leading"
        onPress={onPress}
        disabled={disabled}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled }}
        style={[styles.textTarget, { minHeight: spec.iconTarget, minWidth: spec.iconTarget }]}
      >
        <Text
          variant="label"
          color={look.labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={spec.labelMaxFontScale}
          style={look.opacity < 1 ? { opacity: look.opacity } : null}
        >
          {label}
        </Text>
      </PressableSurface>
    );
  }

  const isClose = kind === 'close';
  return (
    <ChromeIconButton
      testID="sheet-top-bar-leading"
      icon={isClose ? 'close' : 'back'}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? t(isClose ? 'ariaLabels.close' : 'ariaLabels.back')}
    />
  );
});

/**
 * The trailing action on its own, for a bespoke header that cannot be a
 * SheetTopBar (the create drawer's editable name) but still owes the same look
 * and behaviour.
 */
export const SheetTopBarTrailingButton = React.memo(function SheetTopBarTrailingButton({
  label,
  kind,
  onPress,
  disabled = false,
  loading = false,
  prominent = false,
  destructive = false,
  icon,
  accessibilityLabel,
  accessibilityHint,
}: SheetTopBarTrailing) {
  const { systemColors, brandColors, variant, spacing } = useTheme();
  const spec = topBarFor(variant);
  const inert = disabled || loading;
  const handlePress = useCallback(() => {
    if (!inert) onPress();
  }, [inert, onPress]);

  const look = resolveTopBarActionLook(spec, actionColors(systemColors, brandColors), {
    kind: resolveTrailingKind({ kind, prominent }),
    icon,
    prominent,
    destructive,
    disabled,
    surface: 'sheet',
  });

  if (look.glyph) {
    return (
      <TopBarConfirmGlyph
        testID="sheet-top-bar-trailing"
        spinnerTestID="sheet-top-bar-spinner"
        glyph={look.glyph}
        fillColor={look.fillColor}
        glyphColor={look.labelColor}
        glyphSize={spec.glyphSize}
        opacity={look.opacity}
        size={spec.iconTarget}
        hitSlop={0}
        loading={loading}
        inert={inert}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
      />
    );
  }

  // The capsule stays a solid fill, the same rule as Button's filled CTA, which
  // never goes translucent. Dimmed as a whole while disabled.
  const surface = look.filled
    ? [
        styles.capsule,
        {
          backgroundColor: look.fillColor,
          height: spec.confirmHeight,
          borderRadius: spec.confirmHeight / 2,
          paddingHorizontal: spec.confirmPaddingHorizontal,
          opacity: look.opacity,
        },
      ]
    : null;
  const dimLabel = !look.filled && look.opacity < 1 ? { opacity: look.opacity } : null;

  return (
    <PressableSurface
      testID="sheet-top-bar-trailing"
      onPress={handlePress}
      disabled={inert}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[styles.textTarget, { minHeight: spec.iconTarget, minWidth: spec.iconTarget }]}
    >
      <View style={[surface, icon ? [styles.iconRow, { gap: spacing[1] }] : null]}>
        {icon ? (
          <View testID="sheet-top-bar-trailing-icon" style={[dimLabel, loading ? styles.hidden : null]}>
            <Icon name={icon} size={TRAILING_ICON_SIZE} color={look.labelColor} />
          </View>
        ) : null}
        {/* The label stays in the tree while loading, only hidden, so the slot
            keeps the label's width and nothing beside it moves. */}
        <Text
          variant="label"
          color={look.labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={spec.labelMaxFontScale}
          style={[look.fontWeight ? { fontWeight: look.fontWeight } : null, dimLabel, loading ? styles.hidden : null]}
        >
          {label}
        </Text>
        {loading ? (
          <View style={styles.spinner} testID="sheet-top-bar-spinner">
            <ActivityIndicator size="small" color={look.labelColor} />
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
  accentColor,
  error,
  reserveErrorSlot = false,
  testID,
}: SheetTopBarProps) {
  const { systemColors, brandColors, spacing, textStyles, borderRadius } = useTheme();
  const hasAccent = accentColor !== undefined;
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
        {hasAccent ? (
          <View
            testID="sheet-top-bar-accent"
            style={[
              styles.accent,
              { borderRadius: borderRadius.sm, backgroundColor: accentColor ?? systemColors.separator },
            ]}
          />
        ) : (
          <View style={[styles.balance, { width: Math.max(0, trailingWidth - leadingWidth) }]} />
        )}
        <View
          testID="sheet-top-bar-title"
          style={[styles.titles, hasAccent ? styles.startAligned : null, { marginHorizontal: spacing[2] }]}
        >
          <Text
            variant="headline"
            numberOfLines={1}
            accessibilityRole="header"
            style={hasAccent ? styles.startText : styles.centredText}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              numberOfLines={1}
              style={hasAccent ? styles.startText : styles.centredText}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {hasAccent ? null : <View style={[styles.balance, { width: Math.max(0, leadingWidth - trailingWidth) }]} />}
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
  startAligned: {
    alignItems: 'flex-start',
  },
  startText: {
    textAlign: 'left',
  },
  accent: {
    width: 4,
    height: 32,
  },
  textTarget: {
    justifyContent: 'center',
  },
  capsule: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  errorSlot: {
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
