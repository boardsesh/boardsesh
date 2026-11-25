// @vitest-environment jsdom
//
// Back from one wizard step to the one under it is not leaving the flow: the
// screen's leaving report waits for `removed` and is dropped for a step back.
// Closing the whole modal still reports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

type Removed = (event: { target?: string; data: { action: { type: string; payload?: object } } }) => void;
const nav = vi.hoisted(() => ({
  listeners: [] as Removed[],
  state: { index: 0, routes: [] as { key: string; name: string }[] },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    getState: () => nav.state,
    addListener: (_event: string, listener: Removed) => {
      nav.listeners.push(listener);
      return () => {
        nav.listeners = nav.listeners.filter((registered) => registered !== listener);
      };
    },
  }),
}));

const { steppedBackOntoWizardStep, useSteppedBackInWizard } = await import('../use-stepped-back-in-wizard');

const where = { key: 'where-1', name: 'add/index' };
const gym = { key: 'gym-1', name: 'add/gym' };
const picker = { key: 'picker-1', name: 'index' };

describe('steppedBackOntoWizardStep', () => {
  it.each([
    {
      name: 'Back from Which gym? onto Where',
      state: { index: 1, routes: [picker, where] },
      action: { type: 'GO_BACK' },
      expected: true,
    },
    { name: 'a swipe (POP 1)', state: { index: 1, routes: [picker, where] }, action: { type: 'POP' }, expected: true },
    {
      name: 'Back from step 1 onto the picker',
      state: { index: 0, routes: [picker] },
      action: { type: 'GO_BACK' },
      expected: false,
    },
    {
      name: 'a dismissal of several screens',
      state: { index: 0, routes: [where] },
      action: { type: 'POP', payload: { count: 2 } },
      expected: false,
    },
    {
      name: 'the whole stack torn down (the screen is still in it)',
      state: { index: 2, routes: [picker, where, gym] },
      action: { type: 'GO_BACK' },
      expected: false,
    },
  ])('$name: $expected', ({ state, action, expected }) => {
    expect(steppedBackOntoWizardStep(state, gym.key, action)).toBe(expected);
  });
});

describe('useSteppedBackInWizard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nav.listeners = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the report when the screen was popped back onto a wizard step', () => {
    const report = vi.fn();
    const { result, unmount } = renderHook(() => useSteppedBackInWizard());
    unmount();
    result.current(report);
    nav.state = { index: 1, routes: [picker, where] };
    for (const listener of nav.listeners) listener({ target: gym.key, data: { action: { type: 'GO_BACK' } } });
    vi.runAllTimers();
    expect(report).not.toHaveBeenCalled();
    expect(nav.listeners).toEqual([]);
  });

  it('sends the report when the wizard is closed', () => {
    const report = vi.fn();
    const { result, unmount } = renderHook(() => useSteppedBackInWizard());
    unmount();
    result.current(report);
    // No `removed` for a screen inside a dismissed modal.
    vi.runAllTimers();
    expect(report).toHaveBeenCalledOnce();
  });
});
