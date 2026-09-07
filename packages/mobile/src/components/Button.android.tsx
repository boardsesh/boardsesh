// Button — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose. Retires react-native-paper for THIS control (the dep
// stays until the paper-removal endgame, #3273).
//
// The emphasis tier maps onto the Compose Material 3 button family:
//   filled   → Button (brand container)        tonal → FilledTonalButton (MD3
//   outlined → OutlinedButton                          secondaryContainer)
//   text     → TextButton
// Material is opaque, so the `over` surface prop is inert here (a Material button
// is AA-safe on any surface). `role='destructive'` swaps in the brand error
// tokens — mirroring MoreForm.android's destructive Button/TextButton. `loading`
// (no native equivalent) swaps the leading icon for a CircularProgressIndicator
// and disables the button. The press/haptic guard lives in Button.logic.ts.

import { Host } from '@expo/ui';
import {
  Button as ComposeButton,
  FilledTonalButton,
  Icon,
  OutlinedButton,
  CircularProgressIndicator,
  Row,
  Text,
  TextButton,
} from '@expo/ui/jetpack-compose';
import {
  defaultMinSize,
  fillMaxWidth,
  height as heightModifier,
  padding,
  size,
} from '@expo/ui/jetpack-compose/modifiers';
import type { ImageSourcePropType } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { buttonFillAxes, buttonMatchContents, makeButtonPressHandler, pinnedButtonHeight } from './Button.logic';
import { sizeConfig, type ButtonProps } from './Button.types';
import type { IconName } from './icon-map';

// Semantic icon → Material XML vector drawable. The `.xml` files are bundled as
// ASSETS (metro.config.js adds `xml` to resolver.assetExts), so `require()` gives
// the Compose `Icon` a vector-drawable source it tints itself — Compose can't read
// react-native-paper's MDI font-glyph names (`iconMap[icon].android`). Only the
// icons actually used on `<Button icon=...>` call sites are mapped; any other icon
// renders label-only on Android.
const BUTTON_ICON_SOURCE: Partial<Record<IconName, ImageSourcePropType>> = {
  upload: require('../../assets/material-icons/upload.xml'),
  link: require('../../assets/material-icons/link.xml'),
  delete: require('../../assets/material-icons/delete.xml'),
  copy: require('../../assets/material-icons/copy.xml'),
  'check.small': require('../../assets/material-icons/check-small.xml'),
  share: require('../../assets/material-icons/share.xml'),
  transfer: require('../../assets/material-icons/transfer.xml'),
  camera: require('../../assets/material-icons/camera.xml'),
  add: require('../../assets/material-icons/add.xml'),
  refresh: require('../../assets/material-icons/refresh.xml'),
  instagram: require('../../assets/material-icons/instagram.xml'),
  'open.external': require('../../assets/material-icons/open-external.xml'),
  'chevron.right': require('../../assets/material-icons/chevron-right.xml'),
  lock: require('../../assets/material-icons/lock.xml'),
};

export function Button({
  title,
  onPress,
  accessibilityLabel,
  variant = 'filled',
  size: buttonSize = 'medium',
  icon,
  disabled = false,
  loading = false,
  haptic = true,
  tintColor,
  minHeight,
  role = 'default',
  testID,
  style,
}: ButtonProps) {
  const { brandColors, colorScheme } = useTheme();
  const handlePress = makeButtonPressHandler({ onPress, disabled, loading, haptic });

  // A Compose Button takes its accessible name from its Text content (the title),
  // and @expo/ui 56.0.18 exposes no contentDescription modifier (`semantics` only
  // carries an autofill `contentType`), so a distinct `accessibilityLabel` can't be
  // applied on Android — TalkBack reads the title. iOS applies it via the modifier.
  // Warn in dev so a divergent label doesn't silently regress (today only the two
  // follow-toggle buttons pass one, and their title already reads sensibly).
  if (__DEV__ && accessibilityLabel != null && accessibilityLabel !== title) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Button] accessibilityLabel "${accessibilityLabel}" is not applied on Android ` +
        `(Compose labels from the title "${title}"); TalkBack will read the title.`,
    );
  }

  const config = sizeConfig[buttonSize];
  const isDestructive = role === 'destructive';
  const fillColor = tintColor ?? brandAccentColor(brandColors);
  const accentColor = tintColor ?? brandColors.primary;

  // Per-variant Compose colours. tonal intentionally takes the MD3 default
  // (secondaryContainer / onSecondaryContainer) and ignores tintColor — byte
  // parity with Paper's `contained-tonal`. Destructive uses the brand error
  // tokens (MoreForm.android idiom).
  let colors: { containerColor?: string; contentColor?: string } | undefined;
  if (variant === 'filled') {
    colors = isDestructive
      ? { containerColor: brandColors.error, contentColor: brandColors.onPrimary }
      : { containerColor: fillColor, contentColor: brandColors.onPrimary };
  } else if (variant === 'tonal') {
    colors = isDestructive ? { containerColor: brandColors.error, contentColor: brandColors.onPrimary } : undefined;
  } else {
    colors = { contentColor: isDestructive ? brandColors.error : accentColor };
  }

  // The spinner needs an explicit colour (it defaults to the M3 primary, not the
  // button's content colour). The leading Icon omits `color` so it inherits the
  // button's LocalContentColor for free.
  let spinnerColor: string;
  if (variant === 'filled') {
    // White on the brand fill (destructive fills with the error container, still white content).
    spinnerColor = brandColors.onPrimary;
  } else if (variant === 'tonal') {
    // Non-destructive tonal content ≈ brand primary; destructive fills the error
    // container, so its content (and the spinner) is white (onPrimary), not error.
    spinnerColor = isDestructive ? brandColors.onPrimary : brandColors.primary;
  } else {
    spinnerColor = isDestructive ? brandColors.error : accentColor;
  }

  const Comp =
    variant === 'tonal'
      ? FilledTonalButton
      : variant === 'outlined'
        ? OutlinedButton
        : variant === 'text'
          ? TextButton
          : ComposeButton;

  const fills = buttonFillAxes(style);
  const pinnedHeight = pinnedButtonHeight(style);
  const iconSource = icon ? BUTTON_ICON_SOURCE[icon] : undefined;

  // Compose has no discrete height buckets: a button is exactly its content plus
  // `contentPadding`, so `small` lands at 40dp — under the 44 touch floor. Callers
  // that sit in a row of 44dp controls pass `minHeight`; `defaultMinSize` is the
  // Compose idiom for exactly that (a floor, not a fixed height, so a long label
  // or large Dynamic Type still grows the button).
  //
  // A pinned `height` is the caller asking for one height across a row of buttons
  // whose native styles measure differently (the tick bar). Compose takes it
  // directly; the Host stops measuring that axis so the value survives.
  const composeModifiers = [
    ...(fills.width ? [fillMaxWidth()] : []),
    ...(pinnedHeight != null ? [heightModifier(pinnedHeight)] : []),
    ...(minHeight != null ? [defaultMinSize({ minHeight })] : []),
  ];

  return (
    <Host matchContents={buttonMatchContents(style)} colorScheme={colorScheme} style={style} testID={testID}>
      <Comp
        onClick={handlePress}
        enabled={!(disabled || loading)}
        colors={colors}
        contentPadding={{
          start: config.paddingHorizontal,
          top: config.paddingVertical,
          end: config.paddingHorizontal,
          bottom: config.paddingVertical,
        }}
        modifiers={composeModifiers}
      >
        <Row verticalAlignment="center">
          {loading ? (
            <CircularProgressIndicator
              color={spinnerColor}
              strokeWidth={2}
              modifiers={[size(config.iconSize, config.iconSize), padding(0, 0, 8, 0)]}
            />
          ) : iconSource ? (
            <Icon source={iconSource} size={config.iconSize} modifiers={[padding(0, 0, 8, 0)]} />
          ) : null}
          <Text>{title}</Text>
        </Row>
      </Comp>
    </Host>
  );
}
