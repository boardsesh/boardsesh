// The native stack header's leading and trailing actions, rendered by
// `useHeaderActions` as a screen's `headerLeft` / `headerRight`. Same vocabulary
// as SheetTopBar (cancel / close / back; a trailing confirm) so sheets and
// screens put their actions in the same places with the same words.
//
// No fill of their own: on iOS 26 the native bar wraps each item in its Liquid
// Glass capsule, and on Material the top app bar draws flat actions. Sized like
// the spray editor's header actions (SprayEditorHeaderActions), which set the
// precedent for a custom view in a native bar.
import React, { useCallback } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { glassSize } from '../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../theme/typography';
import type { SheetTopBarLeading, SheetTopBarTrailing } from './SheetTopBar';

/** The header's glyph size, the same as the X the board picker and spray flow already draw. */
const HEADER_GLYPH_SIZE = 22;

type TintProps = {
  /** The header's own tint, handed to `headerLeft` / `headerRight` by the stack. */
  tintColor?: ColorValue;
};

export const HeaderLeadingButton = React.memo(function HeaderLeadingButton({
  kind,
  onPress,
  accessibilityLabel,
  tintColor,
}: SheetTopBarLeading & TintProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const color = tintColor ?? systemColors.label;

  if (kind === 'cancel') {
    const label = t('actions.cancel');
    return (
      <PressableSurface
        testID="header-leading-action"
        onPress={onPress}
        feedback="opacity"
        hitSlop={spacing[2]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={styles.textTarget}
      >
        <Text variant="body" color={color} numberOfLines={1} maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}>
          {label}
        </Text>
      </PressableSurface>
    );
  }

  const isClose = kind === 'close';
  return (
    <PressableSurface
      testID="header-leading-action"
      onPress={onPress}
      feedback="opacity"
      hitSlop={spacing[2]}
      rippleBorderless
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? t(isClose ? 'ariaLabels.close' : 'ariaLabels.back')}
      style={styles.glyphTarget}
    >
      <Icon name={isClose ? 'close' : 'back'} size={HEADER_GLYPH_SIZE} color={color} />
    </PressableSurface>
  );
});

export const HeaderTrailingButton = React.memo(function HeaderTrailingButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  prominent = false,
  accessibilityLabel,
  tintColor,
}: SheetTopBarTrailing & TintProps) {
  const { systemColors, brandColors } = useTheme();
  const inert = disabled || loading;
  const handlePress = useCallback(() => {
    if (!inert) onPress();
  }, [inert, onPress]);
  // The confirm reads as the brand accent in semibold; a plain trailing action
  // takes the header's tint. Disabled greys either.
  const color = disabled
    ? systemColors.tertiaryLabel
    : prominent
      ? brandColors.primary
      : (tintColor ?? systemColors.label);

  return (
    <PressableSurface
      testID="header-trailing-action"
      onPress={handlePress}
      disabled={inert}
      feedback="opacity"
      hitSlop={spacing[2]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={styles.textTarget}
    >
      <View>
        {/* Hidden, not removed, while loading: the item keeps the label's width,
            so the native bar does not re-lay out its items mid-save. */}
        <Text
          variant="body"
          color={color}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[prominent ? styles.prominentLabel : null, loading ? styles.hidden : null]}
        >
          {label}
        </Text>
        {loading ? (
          <View style={styles.spinner} testID="header-trailing-spinner">
            <ActivityIndicator size="small" />
          </View>
        ) : null}
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  textTarget: {
    minHeight: glassSize.mini,
    minWidth: glassSize.capsule,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphTarget: {
    width: glassSize.mini,
    height: glassSize.mini,
    alignItems: 'center',
    justifyContent: 'center',
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
});
