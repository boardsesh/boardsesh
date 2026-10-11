// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { SwitcherFormModel } from '../SwitcherForm.types';

const controls = vi.hoisted(() => ({
  confirm: vi.fn(),
  canAbort: vi.fn(() => true),
  abort: vi.fn(() => true),
  stamp: vi.fn(),
  alert: vi.fn(),
  model: undefined as SwitcherFormModel | undefined,
}));
vi.mock('expo-router', () => ({ Redirect: () => null }));
vi.mock('react-native', () => ({
  ActivityIndicator: () => null,
  View: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: controls.alert },
}));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ hapticError: vi.fn(), hapticLight: vi.fn() }));
vi.mock('../../lib/sentry', () => ({
  isSentryEnabled: true,
  nativeSentryCrash: vi.fn(),
  nativeAbortSentryCrash: controls.abort,
  canNativeAbortSentryCrash: controls.canAbort,
  setSentryDiagnosticTestContext: controls.stamp,
}));
vi.mock('../../lib/sentry-diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sentry-diagnostics')>();
  return {
    ...actual,
    createSentryDiagnosticTestRunId: () => 'visible-test-run',
    beginSentryDiagnosticTest: vi.fn(actual.beginSentryDiagnosticTest),
    finishUnavailableSentryNativeAbort: vi.fn(actual.finishUnavailableSentryNativeAbort),
  };
});
vi.mock('../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: { isTester: true }, isLoading: false }) }));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => controls.confirm }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../SwitcherForm', () => ({
  SwitcherForm: ({ model }: { model: SwitcherFormModel }) => {
    controls.model = model;
    return null;
  },
}));

import { SentryDiagnosticsScreen } from '../SentryDiagnosticsScreen';
import { beginSentryDiagnosticTest, finishUnavailableSentryNativeAbort } from '../../lib/sentry-diagnostics';

beforeEach(() => {
  vi.clearAllMocks();
  controls.canAbort.mockReturnValue(true);
  controls.abort.mockReturnValue(true);
  controls.confirm.mockResolvedValue(true);
});

async function tapAbort() {
  const row = controls.model?.sections[0].rows.find((candidate) => candidate.key === 'native-abort');
  expect(row?.kind).toBe('action');
  await act(async () => {
    if (row?.kind === 'action') row.onPress();
  });
}

it('shows a run ID before crashing and records that exact confirmation ID', async () => {
  render(<SentryDiagnosticsScreen />);
  await tapAbort();
  expect(controls.confirm.mock.calls[0][0].message).toContain('visible-test-run');
  expect(controls.model?.sections[0].rows.find((row) => row.key === 'test-run')).toMatchObject({
    value: 'visible-test-run',
  });
  expect(beginSentryDiagnosticTest).toHaveBeenCalledWith('native-abort', 'visible-test-run');
  expect(controls.stamp).not.toHaveBeenCalled();
  expect(controls.abort).toHaveBeenCalledExactlyOnceWith('visible-test-run');
});

it('does not leave test tags or an active crash operation when confirmation is cancelled', async () => {
  controls.confirm.mockResolvedValue(false);
  render(<SentryDiagnosticsScreen />);
  await tapAbort();
  expect(beginSentryDiagnosticTest).not.toHaveBeenCalled();
  expect(controls.stamp).not.toHaveBeenCalled();
  expect(controls.abort).not.toHaveBeenCalled();
});

it('reports unavailable native capture without labeling later real crashes as tests', async () => {
  controls.canAbort.mockReturnValue(false);
  render(<SentryDiagnosticsScreen />);
  await tapAbort();
  expect(controls.alert).toHaveBeenCalledWith('Native abort unavailable', expect.any(String));
  expect(beginSentryDiagnosticTest).not.toHaveBeenCalled();
  expect(controls.stamp).not.toHaveBeenCalled();
  expect(controls.abort).not.toHaveBeenCalled();
});

it('finishes the diagnostic operation when native preparation declines the crash', async () => {
  controls.abort.mockReturnValue(false);
  render(<SentryDiagnosticsScreen />);
  await tapAbort();
  expect(finishUnavailableSentryNativeAbort).toHaveBeenCalledWith('visible-test-run');
  expect(controls.alert).toHaveBeenCalledWith('Native abort unavailable', expect.any(String));
  expect(controls.stamp).not.toHaveBeenCalled();
});
