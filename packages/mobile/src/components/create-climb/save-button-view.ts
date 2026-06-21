import type { SaveButtonState } from './use-create-climb-screen';

/** Minimal translate signature so this stays a pure, renderer-free util. */
export type TranslateSave = (key: string) => string;

export type SaveButtonView = {
  /** Resolved button label. */
  title: string;
  /** Leading icon, or null when the button shows none. */
  icon: 'check.small' | 'lock' | null;
  /** Whether the press is suppressed (saving in flight / locked from editing). */
  disabled: boolean;
  /** Which brand colour the filled button takes. */
  tint: 'primary' | 'success';
};

/**
 * Map the save state machine to the Save button's appearance. Pure so the five
 * states (ready, saving, justSaved, editLocked, login) can be unit-tested
 * without a renderer. Each state is visually distinct: `login` prompts sign-in,
 * `editLocked` shows a lock, `justSaved` turns green with a check, `saving`
 * disables, `ready` is the plain primary action. Keys are static literals so the
 * i18n orphan checker still sees them.
 */
export function deriveSaveButtonView(state: SaveButtonState, t: TranslateSave): SaveButtonView {
  switch (state) {
    case 'saving':
      return { title: t('mobile.create.save.saving'), icon: null, disabled: true, tint: 'primary' };
    case 'justSaved':
      return { title: t('mobile.create.save.done'), icon: 'check.small', disabled: false, tint: 'success' };
    case 'editLocked':
      return { title: t('mobile.create.save.idle'), icon: 'lock', disabled: true, tint: 'primary' };
    case 'login':
      return { title: t('mobile.create.save.login'), icon: null, disabled: false, tint: 'primary' };
    case 'ready':
    default:
      return { title: t('mobile.create.save.idle'), icon: null, disabled: false, tint: 'primary' };
  }
}
