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
  /**
   * True for a warning that only says what a PUBLISH still needs (a start and a
   * finish). It describes ordinary work in progress rather
   * than something that went wrong, so it gives its line box up to the hold
   * heatmap's legend while the heat is on. On a spray wall, where Save publishes
   * by default, it is up from the first hold until the climb is
   * complete — which is exactly when the heatmap is in use.
   */
  yieldsToHeatmap?: boolean;
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
  /**
   * Where the "Save as draft" switch sits. Decides only the wording of the two
   * "it is saved" lines: with the switch off, calling a climb a draft is wrong —
   * and on a spray wall it is off from the start. Absent reads as a draft, which
   * is what every caller meant before the switch had a second default.
   */
  isDraft?: boolean;
  /**
   * Signed out. The header's Save still reads "Save" (its full "Sign in to
   * save" doesn't fit beside the name), so this line says what the tap does.
   */
  signedOut?: boolean;
  /** No holds painted, so Save is disabled; this line says why. */
  noHolds?: boolean;
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
  // An empty editor has no work to report on, only the two things the header's
  // Save is waiting for. Neither is announced: both are up from the first frame.
  if (!state.hasContent) {
    if (state.signedOut) return { text: t('mobile.create.save.login'), tone: 'muted', announce: false };
    if (state.noHolds) return { text: t('mobile.create.save.needsHold'), tone: 'muted', announce: false };
    return null;
  }

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
    return {
      text: t('mobile.create.publish.blocked'),
      tone: 'warning',
      announce: true,
      yieldsToHeatmap: true,
    };
  }

  // Save is disabled with no holds; a name or description alone can't be saved.
  if (state.noHolds) {
    return { text: t('mobile.create.save.needsHold'), tone: 'muted', announce: false, yieldsToHeatmap: true };
  }

  // Signed out, the header's Save goes to sign-in. Said here, in muted tone,
  // in place of the on-device line: the draft is kept on the phone either way,
  // and the close button's hint already says so.
  if (state.signedOut) {
    return { text: t('mobile.create.save.login'), tone: 'muted', announce: false };
  }

  const savingAsDraft = state.isDraft ?? true;

  if (state.hasSavedClimb) {
    if (state.hasUnsavedEdits) {
      return { text: t('mobile.create.autosave.unsyncedEdits'), tone: 'muted', announce: false };
    }
    return {
      text: savingAsDraft ? t('mobile.create.autosave.inAccount') : t('mobile.create.autosave.inAccountPublish'),
      tone: 'muted',
      announce: true,
    };
  }

  return {
    text: savingAsDraft ? t('mobile.create.autosave.onDevice') : t('mobile.create.autosave.onDevicePublish'),
    tone: 'muted',
    announce: false,
  };
}
