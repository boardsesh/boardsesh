import { describe, it, expect } from 'vitest';
import { deriveSaveButtonView } from '../save-button-view';
import { deriveDraftStatusView, type DraftStatusState } from '../draft-status-view';
import type { SaveButtonState } from '../use-create-climb-screen';

// Identity translate: labels come back as the i18n key, so each test asserts
// both the resolved label path and the rest of the view in one shot.
const t = (key: string) => key;

describe('deriveSaveButtonView', () => {
  it('ready: the plain confirm, enabled', () => {
    expect(deriveSaveButtonView('ready', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.idle',
      disabled: false,
      loading: false,
      icon: null,
      accessibilityHint: null,
    });
  });

  it('saving: the bar spinner stands in for the label, which keeps its width', () => {
    expect(deriveSaveButtonView('saving', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.saving',
      disabled: false,
      loading: true,
      icon: null,
      accessibilityHint: null,
    });
  });

  it('justSaved: says Saved, still live for the next save', () => {
    expect(deriveSaveButtonView('justSaved', t)).toEqual({
      label: 'mobile.create.save.done',
      accessibilityLabel: 'mobile.create.save.done',
      disabled: false,
      loading: false,
      icon: null,
      accessibilityHint: null,
    });
  });

  it('editLocked: disabled behind a lock, and says why', () => {
    expect(deriveSaveButtonView('editLocked', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.idle',
      disabled: true,
      loading: false,
      icon: 'lock',
      accessibilityHint: 'createClimbForm.alerts.editWindowExpired',
    });
  });

  it('login: short label on screen, the sign-in prompt spoken, enabled so the tap routes to auth', () => {
    expect(deriveSaveButtonView('login', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.login',
      disabled: false,
      loading: false,
      icon: null,
      accessibilityHint: null,
    });
  });

  it('disables Save until the climb is ready, but never the signed-out way to sign in', () => {
    expect(deriveSaveButtonView('ready', t, false).disabled).toBe(true);
    expect(deriveSaveButtonView('justSaved', t, false).disabled).toBe(true);
    expect(deriveSaveButtonView('login', t, false).disabled).toBe(false);
    expect(deriveSaveButtonView('ready', t, true).disabled).toBe(false);
  });

  it('every state is distinct in at least one of label/spoken label/disabled/loading', () => {
    const states: SaveButtonState[] = ['ready', 'saving', 'justSaved', 'editLocked', 'login'];
    const fingerprints = states.map((state) => {
      const view = deriveSaveButtonView(state, t);
      return `${view.label}|${view.accessibilityLabel}|${view.disabled}|${view.loading}`;
    });
    expect(new Set(fingerprints).size).toBe(states.length);
  });

  it('login, ready and editLocked look different on screen, not only to a screen reader', () => {
    // What a sighted climber sees: the button's label, glyph and enabled state,
    // plus the status line under the tools.
    const status: DraftStatusState = {
      hasContent: true,
      localPersistenceAvailable: true,
      hasSavedClimb: false,
      hasUnsavedEdits: false,
      saveFailed: false,
      publishBlocked: false,
    };
    const visible = (state: SaveButtonState, signedOut: boolean) => {
      const view = deriveSaveButtonView(state, t);
      const line = deriveDraftStatusView({ ...status, signedOut }, t)?.text ?? '';
      return `${view.label}|${view.icon}|${view.disabled}|${line}`;
    };
    const ready = visible('ready', false);
    const login = visible('login', true);
    const locked = visible('editLocked', false);
    expect(new Set([ready, login, locked]).size).toBe(3);
    // The sign-in cue is the status line, the lock cue is the glyph.
    expect(login).toContain('mobile.create.save.login');
    expect(deriveSaveButtonView('editLocked', t).icon).toBe('lock');
  });
});
