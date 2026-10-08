import { describe, expect, it } from 'vitest';
import { deriveDraftStatusView, type DraftStatusState } from '../draft-status-view';

// The line answers "is my work safe, and where is it?" — the question the create
// drawer had no answer to at all. One case per branch, plus the two orderings
// that decide which truth wins when several apply at once.

const identity = (key: string) => key;

const base: DraftStatusState = {
  hasContent: true,
  localPersistenceAvailable: true,
  hasSavedClimb: false,
  hasUnsavedEdits: false,
  saveFailed: false,
  publishBlocked: false,
};

describe('deriveDraftStatusView', () => {
  it('says nothing about an empty editor', () => {
    expect(deriveDraftStatusView({ ...base, hasContent: false }, identity)).toBeNull();
  });

  it('asks for a first hold while the editor is empty, since Save is disabled', () => {
    expect(deriveDraftStatusView({ ...base, hasContent: false, noHolds: true }, identity)).toEqual({
      text: 'mobile.create.save.needsHold',
      tone: 'muted',
      announce: false,
    });
  });

  it('asks for a first hold when only a name is typed', () => {
    expect(deriveDraftStatusView({ ...base, noHolds: true }, identity)?.text).toBe('mobile.create.save.needsHold');
  });

  it('says Save goes to sign-in while signed out, empty or not', () => {
    for (const hasContent of [false, true]) {
      expect(
        deriveDraftStatusView({ ...base, hasContent, signedOut: true, noHolds: !hasContent }, identity)?.text,
      ).toBe('mobile.create.save.login');
    }
  });

  it('lets the sign-in note give its line to the heatmap, empty or not', () => {
    for (const hasContent of [false, true]) {
      expect(deriveDraftStatusView({ ...base, hasContent, signedOut: true }, identity)?.yieldsToHeatmap).toBe(true);
    }
  });

  it('keeps storage truth and failures ahead of the sign-in note', () => {
    expect(deriveDraftStatusView({ ...base, signedOut: true, localPersistenceAvailable: false }, identity)?.text).toBe(
      'mobile.create.autosave.notStored',
    );
    expect(deriveDraftStatusView({ ...base, signedOut: true, publishBlocked: true }, identity)?.text).toBe(
      'mobile.create.publish.blocked',
    );
  });

  it('reports the on-device copy for a never-saved climb', () => {
    expect(deriveDraftStatusView(base, identity)).toEqual({
      text: 'mobile.create.autosave.onDevice',
      tone: 'muted',
      announce: false,
    });
  });

  it('reports the account copy once a row exists', () => {
    expect(deriveDraftStatusView({ ...base, hasSavedClimb: true }, identity)).toEqual({
      text: 'mobile.create.autosave.inAccount',
      tone: 'muted',
      announce: true,
    });
  });

  it('says the newest edits are local-only after a save', () => {
    expect(deriveDraftStatusView({ ...base, hasSavedClimb: true, hasUnsavedEdits: true }, identity)).toEqual({
      text: 'mobile.create.autosave.unsyncedEdits',
      tone: 'muted',
      announce: false,
    });
  });

  it('warns when nothing can be stored at all', () => {
    // Signed-out expo-web: every write is dropped, so no other branch may claim
    // the work is kept anywhere.
    expect(deriveDraftStatusView({ ...base, localPersistenceAvailable: false, hasSavedClimb: true }, identity)).toEqual(
      {
        text: 'mobile.create.autosave.notStored',
        tone: 'warning',
        announce: true,
      },
    );
  });

  it('surfaces a failed save in the error tone, outranking the happy states', () => {
    // Without this branch the line reads "Saved on this phone" — true, and silent
    // about the account copy never happening once the 3s toast is gone.
    expect(deriveDraftStatusView({ ...base, saveFailed: true }, identity)).toEqual({
      text: 'mobile.create.autosave.saveFailed',
      tone: 'error',
      announce: true,
    });
    expect(deriveDraftStatusView({ ...base, hasSavedClimb: true, saveFailed: true }, identity)?.tone).toBe('error');
  });

  it('names the missing requirement while a publish is blocked', () => {
    expect(deriveDraftStatusView({ ...base, publishBlocked: true }, identity)).toEqual({
      text: 'mobile.create.publish.blocked',
      tone: 'warning',
      announce: true,
      yieldsToHeatmap: true,
    });
  });

  it('does not call the work a draft while Save is set to publish', () => {
    // A spray wall opens with the draft switch off, so "Draft saved…" was the
    // first thing the line said about a climb that was never going to be one.
    expect(deriveDraftStatusView({ ...base, isDraft: false }, identity)).toEqual({
      text: 'mobile.create.autosave.onDevicePublish',
      tone: 'muted',
      announce: false,
    });
    expect(deriveDraftStatusView({ ...base, isDraft: false, hasSavedClimb: true }, identity)).toEqual({
      text: 'mobile.create.autosave.inAccountPublish',
      tone: 'muted',
      announce: true,
    });
  });

  it('keeps the draft wording while the switch is on, and when a caller does not say', () => {
    expect(deriveDraftStatusView({ ...base, isDraft: true }, identity)?.text).toBe('mobile.create.autosave.onDevice');
    expect(deriveDraftStatusView({ ...base, isDraft: true, hasSavedClimb: true }, identity)?.text).toBe(
      'mobile.create.autosave.inAccount',
    );
    expect(deriveDraftStatusView(base, identity)?.text).toBe('mobile.create.autosave.onDevice');
  });

  it('lets only the publish hint give its line to the heatmap', () => {
    // "What a publish still needs" is ordinary work in progress. A failed save
    // and "nothing is being stored" are not, and keep the line.
    const yields = (state: DraftStatusState) => deriveDraftStatusView(state, identity)?.yieldsToHeatmap === true;
    expect(yields({ ...base, publishBlocked: true })).toBe(true);
    expect(yields({ ...base, saveFailed: true })).toBe(false);
    expect(yields({ ...base, localPersistenceAvailable: false })).toBe(false);
    // A failed save still outranks a publish hint that is also true.
    expect(yields({ ...base, saveFailed: true, publishBlocked: true })).toBe(false);
  });

  it('has no "saving" state — the button already says that', () => {
    // Two "Saving…" strings 20dp apart is noise. Nothing in the input can produce
    // a line other than the six above, so a save in flight leaves the line put.
    const everyText = [
      base,
      { ...base, hasSavedClimb: true },
      { ...base, hasSavedClimb: true, hasUnsavedEdits: true },
      { ...base, localPersistenceAvailable: false },
      { ...base, saveFailed: true },
      { ...base, publishBlocked: true },
    ].map((state) => deriveDraftStatusView(state, identity)?.text);
    expect(everyText).not.toContain('mobile.create.save.saving');
  });
});
