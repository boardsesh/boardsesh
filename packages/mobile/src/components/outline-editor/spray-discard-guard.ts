/**
 * "You have holds you haven't saved" — the dialog, separated from the screen.
 *
 * Its own module for the reason `draft-guard.ts` is: the RULE is pure and tested
 * there, and the WIRING — which button is destructive, which one cancels, and
 * that only the destructive one reaches the action — is the part that is easy to
 * get subtly wrong and impossible to test through a mounted board.
 *
 * Exported rather than wired to a navigation listener inside the editor: SW-09
 * owns the route this screen sits on and therefore owns its back button, and a
 * guard installed from inside would fight the one the route installs.
 */

import { Alert } from 'react-native';
import { withUnsavedDraftGuard } from './draft-guard';

/** The dialog's four strings. Supplied by the caller, which owns the locale. */
export type SprayDiscardStrings = {
  title: string;
  message: string;
  /** Keeps editing. The cancel button. */
  keep: string;
  /** Throws the unsaved holds away. The destructive one. */
  discard: string;
};

/**
 * Run `action`, asking first when it would throw unsaved holds away.
 *
 * With nothing unsaved this is a straight, synchronous call — ordinary
 * navigation must never feel gated. With unsaved work the ONLY path to `action`
 * is the destructive button.
 */
export function confirmDiscardSprayEdits(hasUnsaved: boolean, action: () => void, strings: SprayDiscardStrings): void {
  withUnsavedDraftGuard(hasUnsaved, action, (onConfirm) => {
    Alert.alert(strings.title, strings.message, [
      { text: strings.keep, style: 'cancel' },
      { text: strings.discard, style: 'destructive', onPress: onConfirm },
    ]);
  });
}
