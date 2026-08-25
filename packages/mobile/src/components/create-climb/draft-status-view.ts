/** Minimal translate signature so this stays a pure, renderer-free util. */
export type TranslateDraftStatus = (key: string) => string;

/**
 * How loudly the line reads. `muted` is every ordinary state — a successful save
 * gets no green and no tick, because the Save button's own 3s `justSaved` state
 * already carries the momentary confirmation and a PERSISTENT semantic colour
 * reads as an alert that never clears.
 */
export type DraftStatusTone = 'muted' | 'warning' | 'error';

export type DraftStatusView = {
  text: string;
  tone: DraftStatusTone;
  /**
   * Whether entering this state is worth speaking to assistive tech. True only
   * for the states that change the ANSWER to "is my work safe?" — never for the
   * on-device autosave tick, which fires on every keystroke and every hold tap.
   * The row's live region is `none`; this drives a rate-limited announcement.
   */
  announce: boolean;
};

export type DraftStatusState = {
  /** Anything painted or typed. Nothing to say about an empty editor. */
  hasContent: boolean;
  /** False on signed-out expo-web, where nothing is written at all. */
  localPersistenceAvailable: boolean;
  hasSavedClimb: boolean;
  /** Edited since the last successful explicit save. */
  hasUnsavedEdits: boolean;
  /** The last explicit save was rejected for a non-duplicate reason. */
  saveFailed: boolean;
  /** Publishing is selected but the climb has no start or no finish hold. */
  publishBlocked: boolean;
};

/**
 * The persistent one-line answer to "is my work safe, and where is it?", rendered
 * under the Save row. Pure so every branch is table-testable without a renderer;
 * keys are static literals so the i18n orphan checker still sees them.
 *
 * There is deliberately NO "saving…" branch. The Save button already says that
 * while a save is in flight, and two "Saving…" strings 20dp apart is noise — the
 * line simply keeps whatever it said before the press, which stays true.
 */
export function deriveDraftStatusView(state: DraftStatusState, t: TranslateDraftStatus): DraftStatusView | null {
  if (!state.hasContent) return null;

  // Storage truth first: on signed-out expo-web every write is dropped, so no
  // other branch is allowed to claim the work is kept anywhere.
  if (!state.localPersistenceAvailable) {
    return { text: t('mobile.create.autosave.notStored'), tone: 'warning', announce: true };
  }

  // A failed save is the one moment the answer is only PARTLY yes: the work is on
  // the phone, and the account copy silently did not happen. Sticky until the next
  // successful save or a payload change — never on a timer.
  if (state.saveFailed) {
    return { text: t('mobile.create.autosave.saveFailed'), tone: 'error', announce: true };
  }

  // A disabled button must never be mute: while Save is blocked from publishing,
  // this line is what names the missing requirement.
  if (state.publishBlocked) {
    return { text: t('mobile.create.publish.blocked'), tone: 'warning', announce: true };
  }

  if (state.hasSavedClimb) {
    return state.hasUnsavedEdits
      ? { text: t('mobile.create.autosave.unsyncedEdits'), tone: 'muted', announce: false }
      : { text: t('mobile.create.autosave.inAccount'), tone: 'muted', announce: true };
  }

  return { text: t('mobile.create.autosave.onDevice'), tone: 'muted', announce: false };
}
