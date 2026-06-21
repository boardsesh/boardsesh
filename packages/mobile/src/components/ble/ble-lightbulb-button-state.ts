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
  scanningAccessibilityHint?: string,
  longPressAccessibilityHint?: string,
): string | undefined {
  if (isScanning) return scanningAccessibilityHint;
  return longPressAccessibilityHint;
}
