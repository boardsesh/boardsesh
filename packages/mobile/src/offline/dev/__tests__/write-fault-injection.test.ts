// The fault injector is only useful if its synthetic errors are classified the
// same way the real platform ones are — otherwise a device QA run "proves" a
// retry path the real error would never reach. That is what this pins.

import { describe, it, expect, beforeEach } from 'vitest';
import { isDatabaseLockedError } from '@boardsesh/offline-sync';
import { setWriteFault, getWriteFault, takeInjectedWriteFault } from '../write-fault-injection';

beforeEach(() => {
  setWriteFault('off', 0);
});

describe('write fault injection', () => {
  it.each(['ios-lock', 'android-lock', 'android-lock-no-code', 'commit-then-throw'] as const)(
    '%s produces an error the shared lock predicate recognises',
    (mode) => {
      setWriteFault(mode, 1);
      const phase = mode === 'commit-then-throw' ? 'after-commit' : 'before-task';

      const fault = takeInjectedWriteFault(phase);

      expect(fault).toBeInstanceOf(Error);
      expect(isDatabaseLockedError(fault)).toBe(true);
    },
  );

  it('disk-full is NOT lock contention, so the ladder must not retry it', () => {
    setWriteFault('disk-full', 1);

    const fault = takeInjectedWriteFault('before-task');

    expect(fault).toBeInstanceOf(Error);
    expect(isDatabaseLockedError(fault)).toBe(false);
  });

  it('fires exactly failAttempts times and then disarms itself', () => {
    setWriteFault('ios-lock', 1);

    expect(takeInjectedWriteFault('before-task')).toBeInstanceOf(Error);
    expect(takeInjectedWriteFault('before-task')).toBeNull();
    expect(getWriteFault()).toEqual({ mode: 'off', remaining: 0 });
  });

  it('clears immediately when switched off mid-run', () => {
    setWriteFault('ios-lock', 99);
    setWriteFault('off', 0);

    expect(takeInjectedWriteFault('before-task')).toBeNull();
  });

  it('only commit-then-throw fires after the transaction commits', () => {
    setWriteFault('commit-then-throw', 1);
    expect(takeInjectedWriteFault('before-task')).toBeNull();
    expect(takeInjectedWriteFault('after-commit')).toBeInstanceOf(Error);

    setWriteFault('ios-lock', 1);
    expect(takeInjectedWriteFault('after-commit')).toBeNull();
    expect(takeInjectedWriteFault('before-task')).toBeInstanceOf(Error);
  });
});
