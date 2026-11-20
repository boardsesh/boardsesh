// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restTimerForegroundGeneration,
  sameRestTimerForeground,
  setRestTimerForeground,
} from '../../../lib/rest-timer-foreground-state';

const runtime = vi.hoisted(() => ({
  armed: false,
  currentState: 'active',
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return runtime.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      runtime.listeners.add(listener);
      return { remove: () => runtime.listeners.delete(listener) };
    },
  },
}));
vi.mock('../../../hooks/use-rest-timer', () => ({ useRestTimerArmed: () => runtime.armed }));
vi.mock('../RestTimerSessionSync', () => ({ RestTimerSessionSync: () => null }));
vi.mock('../RestTimerAutoAdvanceScheduler', () => ({ RestTimerAutoAdvanceScheduler: () => null }));
vi.mock('../RestTimerPacingSync', () => ({ RestTimerPacingSync: () => null }));
vi.mock('../RestTimerCrewPublisher', () => ({ RestTimerCrewPublisher: () => null }));

import { RestTimerRuntime } from '../RestTimerRuntime';

function appState(nextState: string) {
  act(() => {
    runtime.currentState = nextState;
    for (const listener of runtime.listeners) listener(nextState);
  });
}

beforeEach(() => {
  runtime.armed = false;
  runtime.currentState = 'active';
  setRestTimerForeground(true);
});
afterEach(() => {
  cleanup();
  runtime.listeners.clear();
  setRestTimerForeground(true);
});

describe('timer foreground observation outside the armed gate', () => {
  it('initializes a background mount even when no timer is armed', () => {
    runtime.currentState = 'background';
    render(<RestTimerRuntime />);
    expect(restTimerForegroundGeneration()).toBeNull();
    appState('active');
    expect(restTimerForegroundGeneration()).not.toBeNull();
  });

  it('observes returning active after the timer disarmed in the background', () => {
    runtime.armed = true;
    const view = render(<RestTimerRuntime />);
    const beforeBackground = restTimerForegroundGeneration();
    appState('background');
    runtime.armed = false;
    view.rerender(<RestTimerRuntime />);
    appState('active');
    runtime.armed = true;
    view.rerender(<RestTimerRuntime />);
    expect(sameRestTimerForeground(beforeBackground)).toBe(false);
    expect(sameRestTimerForeground(restTimerForegroundGeneration())).toBe(true);
  });
});
