// The native stack header's leading and trailing actions, rendered by
// `useHeaderActions` as a screen's `headerLeft` / `headerRight`. Same vocabulary
// as SheetTopBar (cancel / close / back; a trailing confirm) and the same spec
// (`theme/top-bar.ts`), so sheets and screens put their actions in the same
// places with the same words and the same look.
//
// Inside UIKit's shared glass capsule (iOS before 26) or Material's flat top app
// bar, an action is text and never a shape: no circle or capsule inside UIKit's
// capsule. On iOS 26 `useHeaderActions` puts the trailing action in native bar
// items; while it saves, or beside an accessory, it renders this button
// `standalone` (hiding UIKit's glass) so it draws the same ✓ circle or brand
// capsule the native prominent item does.
import React, { useCallback, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import { ChromeIconButton } from './ChromeIconButton';
import { TopBarConfirmGlyph } from './TopBarConfirmGlyph';
import { resolveTopBarActionLook, resolveTrailingKind } from './top-bar-action-look';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { glassSize } from '../theme/layout';
import { topBarFor } from '../theme/top-bar';
import type { SheetTopBarLeading, SheetTopBarTrailing } from './SheetTopBar';

export const HeaderLeadingButton = React.memo(function HeaderLeadingButton({
  kind,
  onPress,
  label: customLabel,
  accessibilityLabel,
  disabled = false,
}: SheetTopBarLeading) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors, variant } = useTheme();
  const spec = topBarFor(variant);

  if (kind === 'cancel') {
    const label = customLabel ?? t('actions.cancel');
    const look = resolveTopBarActionLook(
      spec,
      {
        label: systemColors.label,
        primary: brandColors.primary,
        onPrimary: brandColors.onPrimary,
        error: brandColors.error,
      },
      { disabled, surface: 'nativeHeader' },
    );
    return (
      <PressableSurface
        testID="header-leading-action"
        onPress={onPress}
        disabled={disabled}
        feedback="opacity"
        hitSlop={spacing[2]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled }}
        style={[styles.textTarget, { minHeight: spec.nativeBarGlyphFrame, minWidth: spec.nativeBarGlyphFrame }]}
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
      testID="header-leading-action"
      appearance="bare"
      icon={isClose ? 'close' : 'back'}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? t(isClose ? 'ariaLabels.close' : 'ariaLabels.back')}
    />
  );
});

type HeaderTrailingButtonProps = SheetTopBarTrailing & {
  /** Defaults to `header-trailing-action`. */
  testID?: string;
  /**
   * An iOS 26 bar item that hides UIKit's shared glass (`hidesSharedBackground`)
   * and draws its own shape, as `useHeaderActions` renders the confirm while it
   * saves or beside an accessory: the brand ✓ circle, or a brand capsule for a
   * prominent text action, both `glassSize.capsule` tall, the size of the native
   * prominent item they stand in for. Otherwise (inside UIKit's capsule, iOS
   * before 26, Material) the action is text and never a shape.
   */
  standalone?: boolean;
};

export const HeaderTrailingButton = React.memo(function HeaderTrailingButton({
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
  testID = 'header-trailing-action',
  standalone = false,
}: HeaderTrailingButtonProps) {
  const { systemColors, brandColors, variant } = useTheme();
  const spec = topBarFor(variant);
  const inert = disabled || loading;
  const handlePress = useCallback(() => {
    if (!inert) onPress();
  }, [inert, onPress]);
  const look = resolveTopBarActionLook(
    spec,
    {
      label: systemColors.label,
      primary: brandColors.primary,
      onPrimary: brandColors.onPrimary,
      error: brandColors.error,
    },
    {
      kind: resolveTrailingKind({ kind, prominent }),
      icon,
      prominent,
      destructive,
      disabled,
      surface: standalone ? 'standaloneBarItem' : 'nativeHeader',
    },
  );

  if (look.glyph) {
    // The size of the native prominent item it stands in for.
    return (
      <TopBarConfirmGlyph
        testID={testID}
        spinnerTestID="header-trailing-spinner"
        glyph={look.glyph}
        fillColor={look.fillColor}
        glyphColor={look.labelColor}
        glyphSize={spec.glyphSize}
        opacity={look.opacity}
        size={glassSize.capsule}
        hitSlop={0}
        loading={loading}
        inert={inert}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
      />
    );
  }

  return (
    <PressableSurface
      testID={testID}
      onPress={handlePress}
      disabled={inert}
      feedback="opacity"
      hitSlop={spacing[2]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[styles.textTarget, { minHeight: spec.nativeBarGlyphFrame, minWidth: spec.nativeBarGlyphFrame }]}
    >
      <View
        style={
          look.filled
            ? [
                styles.capsule,
                {
                  backgroundColor: look.fillColor,
                  height: glassSize.capsule,
                  borderRadius: glassSize.capsule / 2,
                  paddingHorizontal: spec.confirmPaddingHorizontal,
                  opacity: look.opacity,
                },
              ]
            : null
        }
      >
        {/* Hidden, not removed, while loading: the item keeps the label's width,
            so the native bar does not re-lay out its items mid-save. */}
        <Text
          variant="label"
          color={look.labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={spec.labelMaxFontScale}
          style={[
            look.fontWeight ? { fontWeight: look.fontWeight } : null,
            !look.filled && look.opacity < 1 ? { opacity: look.opacity } : null,
            loading ? styles.hidden : null,
          ]}
        >
          {label}
        </Text>
        {loading ? (
          <View style={styles.spinner} testID="header-trailing-spinner">
            <ActivityIndicator size="small" color={look.labelColor} />
          </View>
        ) : null}
      </View>
    </PressableSurface>
  );
});

/** `headerRight` with an optional accessory (e.g. "?") drawn before the confirm. */
export const HeaderTrailingGroup = React.memo(function HeaderTrailingGroup({
  accessory,
  trailing,
}: {
  accessory?: ReactNode;
  trailing?: HeaderTrailingButtonProps;
}) {
  return (
    <View style={styles.trailingRow}>
      {accessory}
      {trailing ? <HeaderTrailingButton {...trailing} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  trailingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  textTarget: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsule: {
    alignItems: 'center',
    justifyContent: 'center',
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
});
