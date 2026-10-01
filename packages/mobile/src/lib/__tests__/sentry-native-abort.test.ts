import { expect, it, vi } from 'vitest';
import { canRunNativeAbort, runNativeAbort } from '../sentry-native-abort';
import type { DiagnosticSnapshot } from '../mobile-diagnostics';

const snapshot: DiagnosticSnapshot = {
  schemaVersion: 1,
  launch: { launchId: 'current-launch' },
  active: [],
  completed: {},
  breadcrumbs: [],
  overflowCount: 0,
};

it('refuses older binary abort capabilities without invoking them', () => {
  const crashNativeAbort = vi.fn(() => true);
  const legacy = { nativeInitVersion: 1, crashNativeAbort };
  expect(canRunNativeAbort(true, legacy)).toBe(false);
  expect(runNativeAbort(true, legacy, 'visible-run', snapshot)).toBe(false);
  expect(crashNativeAbort).not.toHaveBeenCalled();
});

it('passes the exact visible run ID and current launch snapshot through one native call', () => {
  const crashNativeAbort = vi.fn(() => true);
  expect(runNativeAbort(true, { nativeAbortVersion: 2, crashNativeAbort }, 'visible-run', snapshot)).toBe(true);
  const { breadcrumbs: _breadcrumbs, ...expectedSnapshot } = snapshot;
  expect(crashNativeAbort).toHaveBeenCalledExactlyOnceWith('visible-run', JSON.stringify(expectedSnapshot));
});

it('reports preparation rejection, exceptions and disabled capture without a fallback crash', () => {
  const crashNativeAbort = vi.fn(() => false);
  const nativeModule = { nativeAbortVersion: 2, crashNativeAbort };
  expect(runNativeAbort(true, nativeModule, 'visible-run', snapshot)).toBe(false);
  crashNativeAbort.mockImplementation(() => {
    throw new Error('NDK unavailable');
  });
  expect(runNativeAbort(true, nativeModule, 'visible-run', snapshot)).toBe(false);
  expect(runNativeAbort(false, nativeModule, 'visible-run', snapshot)).toBe(false);
  expect(crashNativeAbort).toHaveBeenCalledTimes(2);
});
