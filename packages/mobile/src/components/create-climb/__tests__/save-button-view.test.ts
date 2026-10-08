import { describe, it, expect } from 'vitest';
import { deriveSaveButtonView } from '../save-button-view';
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
    });
  });

  it('saving: the bar spinner stands in for the label, which keeps its width', () => {
    expect(deriveSaveButtonView('saving', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.saving',
      disabled: false,
      loading: true,
    });
  });

  it('justSaved: says Saved, still live for the next save', () => {
    expect(deriveSaveButtonView('justSaved', t)).toEqual({
      label: 'mobile.create.save.done',
      accessibilityLabel: 'mobile.create.save.done',
      disabled: false,
      loading: false,
    });
  });

  it('editLocked: disabled, keeps the idle label', () => {
    expect(deriveSaveButtonView('editLocked', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.idle',
      disabled: true,
      loading: false,
    });
  });

  it('login: short label on screen, the sign-in prompt spoken, enabled so the tap routes to auth', () => {
    expect(deriveSaveButtonView('login', t)).toEqual({
      label: 'mobile.create.save.idle',
      accessibilityLabel: 'mobile.create.save.login',
      disabled: false,
      loading: false,
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
});
