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

/** Which sentence the bulb's accessibility label should carry. */
export type BleLightbulbLabelKind = 'disconnect' | 'relay' | 'peerDriving' | 'connect';

/**
 * The bulb's accessibility label, chosen from what a tap will ACTUALLY do.
 *
 * All three bulbs used to derive this from `localConnected` alone, so once the
 * peer-held relay landed the label promised "Connect to board" for a tap that
 * commits a preview to the shared queue, or does nothing at all (Fable review,
 * PR #5123). `holderIsAuthoritative` disambiguates `'noop'`, which also covers
 * "no board selected" and "a connect is already in flight" — neither of which
 * should claim a peer is driving.
 *
 * Returns a KIND rather than a translated string so each surface keeps its own
 * wording (the toolbar bulbs say `lightControl.disconnect` where the drawer says
 * `ble.turnOff`), and because the i18n linter hard-fails on `t(variable)` — the
 * keys have to stay literals at the call site.
 */
export function getBleLightbulbLabelKind(
  pressAction: 'noop' | 'connect' | 'disconnect' | 'relay',
  holderIsAuthoritative: boolean,
): BleLightbulbLabelKind {
  if (pressAction === 'disconnect') return 'disconnect';
  if (pressAction === 'relay') return 'relay';
  if (pressAction === 'noop' && holderIsAuthoritative) return 'peerDriving';
  return 'connect';
}
