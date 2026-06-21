import { describe, it, expect } from 'vitest';
import { deriveSaveButtonView } from '../save-button-view';
import type { SaveButtonState } from '../use-create-climb-screen';

// Identity translate: `title` comes back as the i18n key, so each test asserts
// both the resolved label path and the rest of the view in one shot.
const t = (key: string) => key;

describe('deriveSaveButtonView', () => {
  it('ready: plain primary action, enabled, no icon', () => {
    expect(deriveSaveButtonView('ready', t)).toEqual({
      title: 'mobile.create.save.idle',
      icon: null,
      disabled: false,
      tint: 'primary',
    });
  });

  it('saving: disabled while the request is in flight', () => {
    expect(deriveSaveButtonView('saving', t)).toEqual({
      title: 'mobile.create.save.saving',
      icon: null,
      disabled: true,
      tint: 'primary',
    });
  });

  it('justSaved: green confirmation with a check, re-enabled', () => {
    expect(deriveSaveButtonView('justSaved', t)).toEqual({
      title: 'mobile.create.save.done',
      icon: 'check.small',
      disabled: false,
      tint: 'success',
    });
  });

  it('editLocked: locked, shows the lock icon, keeps the idle label', () => {
    expect(deriveSaveButtonView('editLocked', t)).toEqual({
      title: 'mobile.create.save.idle',
      icon: 'lock',
      disabled: true,
      tint: 'primary',
    });
  });

  it('login: distinct sign-in prompt, enabled so the tap can route to auth', () => {
    expect(deriveSaveButtonView('login', t)).toEqual({
      title: 'mobile.create.save.login',
      icon: null,
      disabled: false,
      tint: 'primary',
    });
  });

  it('every state is distinct in at least one of label/icon/disabled/tint', () => {
    const states: SaveButtonState[] = ['ready', 'saving', 'justSaved', 'editLocked', 'login'];
    const fingerprints = states.map((state) => {
      const view = deriveSaveButtonView(state, t);
      return `${view.title}|${view.icon}|${view.disabled}|${view.tint}`;
    });
    expect(new Set(fingerprints).size).toBe(states.length);
  });
});
