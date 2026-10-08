import type { SaveButtonState } from './use-create-climb-screen';

/** Minimal translate signature so this stays a pure, renderer-free util. */
export type TranslateSave = (key: string) => string;

export type SaveButtonView = {
  /** What the top-bar confirm says. */
  label: string;
  /** What a screen reader says, when it says more than the label. */
  accessibilityLabel: string;
  /** Whether the press is refused: locked from editing, or the climb is not ready. */
  disabled: boolean;
  /** A spinner stands in for the label while the save is in flight. */
  loading: boolean;
  /** A glyph before the label: the lock on a climb past its edit window. */
  icon: 'lock' | null;
  /** Why Save is the way it is, for a screen reader. */
  accessibilityHint: string | null;
};

/**
 * Map the save state machine to the header's trailing Save. Pure so the five
 * states (ready, saving, justSaved, editLocked, login) can be unit-tested
 * without a renderer.
 *
 * The confirm lives in the top bar now, beside the overflow menu and the
 * lightbulb, so its label stays one short word: "Saving…" becomes the bar's
 * spinner, and the signed-out "Sign in to save" (31 characters in French) keeps
 * "Save" on screen and says the rest to a screen reader, while the status line
 * under the tools shows it. A climb past its edit window gets a lock before the
 * label, so it never reads as merely "not ready yet". Keys are static literals
 * so the i18n orphan checker still sees them.
 *
 * `climbReady` is false while the holds can't be saved yet (no holds on a
 * draft, or no start or finish on a publish). Save is disabled then, and the
 * header's counts and the status line say what is missing. Signed out it stays live,
 * because the tap is the way to sign in.
 */
export function deriveSaveButtonView(state: SaveButtonState, t: TranslateSave, climbReady = true): SaveButtonView {
  const idle = t('mobile.create.save.idle');
  switch (state) {
    case 'login':
      return {
        label: idle,
        accessibilityLabel: t('mobile.create.save.login'),
        disabled: false,
        loading: false,
        icon: null,
        accessibilityHint: null,
      };
    case 'saving':
      return {
        label: idle,
        accessibilityLabel: t('mobile.create.save.saving'),
        disabled: false,
        loading: true,
        icon: null,
        accessibilityHint: null,
      };
    case 'justSaved': {
      const done = t('mobile.create.save.done');
      return {
        label: done,
        accessibilityLabel: done,
        disabled: !climbReady,
        loading: false,
        icon: null,
        accessibilityHint: null,
      };
    }
    case 'editLocked':
      return {
        label: idle,
        accessibilityLabel: idle,
        disabled: true,
        loading: false,
        icon: 'lock',
        accessibilityHint: t('createClimbForm.alerts.editWindowExpired'),
      };
    case 'ready':
    default:
      return {
        label: idle,
        accessibilityLabel: idle,
        disabled: !climbReady,
        loading: false,
        icon: null,
        accessibilityHint: null,
      };
  }
}
