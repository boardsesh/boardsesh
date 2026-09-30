// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({ choice: null as boolean | null, flagDefault: false }));

vi.mock('../../lib/personal-grades-preference', () => ({
  usePersonalGradesPreference: () => ({ choice: ctrl.choice, loaded: true, setEnabled: () => {} }),
}));
vi.mock('../../providers/feature-flags-provider', () => ({
  usePersonalGradesDefault: () => ctrl.flagDefault,
}));

import { usePersonalGradesActive } from '../use-personal-grades';

describe('usePersonalGradesActive', () => {
  beforeEach(() => {
    ctrl.choice = null;
    ctrl.flagDefault = false;
  });

  it('is off for a climber who has never chosen, while the flag is off', () => {
    // This is the fail-closed property: an unresolved or unreachable PostHog
    // reads as `false`, so the behaviour arrives by a deliberate rollout rather
    // than by a service outage looking like one.
    expect(renderHook(() => usePersonalGradesActive()).result.current).toBe(false);
  });

  it('follows the flag default for a climber who has never chosen', () => {
    ctrl.flagDefault = true;
    expect(renderHook(() => usePersonalGradesActive()).result.current).toBe(true);
  });

  it('lets an explicit opt-in win over a flag default that is off', () => {
    ctrl.choice = true;
    expect(renderHook(() => usePersonalGradesActive()).result.current).toBe(true);
  });

  it('lets an explicit opt-out win over a flag default that is on', () => {
    // The reason the stored value is tri-state: a deliberate "no" must not be
    // silently reversed later by a flag change.
    ctrl.choice = false;
    ctrl.flagDefault = true;
    expect(renderHook(() => usePersonalGradesActive()).result.current).toBe(false);
  });
});
