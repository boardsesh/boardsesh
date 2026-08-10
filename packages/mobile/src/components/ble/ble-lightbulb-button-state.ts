import type { OpaqueColorValue } from 'react-native';
import type { IconName } from '../icon-map';

type BleLightbulbVisualStateInput = {
  isConnected: boolean;
  connectedColor: string;
  disconnectedColor: string | OpaqueColorValue;
};

type BleLightbulbVisualState = {
  iconName: IconName;
  iconColor: string | OpaqueColorValue;
  backgroundColor?: string;
  shadowColor?: string;
};

export type BleLightbulbDisplayMode = 'scanning' | 'writing' | 'idle';

export function getBleLightbulbDisplayMode(isScanning: boolean, isWriting: boolean): BleLightbulbDisplayMode {
  if (isScanning) return 'scanning';
  if (isWriting) return 'writing';
  return 'idle';
}

// Maps the icon `size` prop onto a spinner size. We can't hand the raw number
// to ActivityIndicator: on iOS a numeric size only resizes the wrapper box and
// leaves the 20pt glyph unscaled, so a large caller would get a small spinner
// floating in a big square. RN's two native sizes are 20pt and 36pt; 32 is the
// midpoint above which 'large' is the closer match to the icon it replaces.
export function getBleLightbulbSpinnerSize(size: number): 'small' | 'large' {
  return size >= 32 ? 'large' : 'small';
}

export function getBleLightbulbVisualState({
  isConnected,
  connectedColor,
  disconnectedColor,
}: BleLightbulbVisualStateInput): BleLightbulbVisualState {
  if (!isConnected) {
    return {
      iconName: 'lightbulb',
      iconColor: disconnectedColor,
    };
  }

  return {
    iconName: 'lightbulb.fill',
    iconColor: connectedColor,
    backgroundColor: `${connectedColor}24`,
    shadowColor: connectedColor,
  };
}

// Resolves the single accessibility hint for the button. While scanning, the
// scanning hint wins outright — we deliberately don't fall back to the
// long-press hint, so "scanning but no scanning hint supplied" never reads as
// the long-press action.
export function getBleLightbulbAccessibilityHint(
  isScanning: boolean,
  isWriting: boolean,
  scanningAccessibilityHint?: string,
  writingAccessibilityHint?: string,
  longPressAccessibilityHint?: string,
): string | undefined {
  if (isScanning) return scanningAccessibilityHint;
  if (isWriting) return writingAccessibilityHint;
  return longPressAccessibilityHint;
}
