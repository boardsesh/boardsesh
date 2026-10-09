// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitcherFormModel } from '../SwitcherForm.types';

// Branch switcher is preview-build (tester) only, so this locks the `isPreviewBuild()`
// guard and the conditional "Current Update" rows. As with the Channel suite, the
// mobile vitest `__DEV__: true` define forces `updatesUsable` false, so the
// switch/custom/reset sections don't render here — that gating is covered by
// `channel-switch.test.ts` + `switcher-form-logic.test.ts` + manual on-device QA.
const captured = vi.hoisted(() => ({ model: null as SwitcherFormModel | null }));
const buildState = vi.hoisted(() => ({ isPreview: true }));

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

vi.mock('expo-updates', () => ({
  channel: 'production',
  runtimeVersion: '1.0.0',
  isEnabled: true,
  isEmbeddedLaunch: false,
  manifest: { metadata: { branchName: 'feat/cool-thing' } },
  updateId: 'abcdef1234567890',
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../lib/preference-store', () => ({
  getPreference: vi.fn().mockResolvedValue(null),
  setPreference: vi.fn(),
  removePreference: vi.fn(),
}));
vi.mock('../../lib/apply-channel-override', () => ({ applyChannelOverride: vi.fn() }));
vi.mock('../../lib/qa/qa-surf', () => ({
  fetchOwnedOtaUpdate: vi.fn(),
  isOtaReloadReceiptCurrent: vi.fn(),
  waitForOtaReloadReceipt: vi.fn(),
  waitForOtaUpdatesIdle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/preview-build', () => ({ isPreviewBuild: () => buildState.isPreview }));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn().mockResolvedValue(false) }));

vi.mock('../SwitcherForm', () => ({
  SwitcherForm: ({ model }: { model: SwitcherFormModel }) => {
    captured.model = model;
    return null;
  },
}));

import { BranchSwitcherScreen } from '../BranchSwitcherScreen';

beforeEach(() => {
  captured.model = null;
  buildState.isPreview = true;
});

describe('BranchSwitcherScreen', () => {
  it('renders nothing outside a preview build', () => {
    buildState.isPreview = false;
    render(createElement(BranchSwitcherScreen));
    // The screen returns null before SwitcherForm, so no model is ever built.
    expect(captured.model).toBeNull();
  });

  it('surfaces the current update info (build channel + running branch) in a preview build', () => {
    render(createElement(BranchSwitcherScreen));

    const current = captured.model?.sections.find((section) => section.key === 'current');
    expect(current).toBeDefined();
    expect(current?.rows).toContainEqual(
      expect.objectContaining({ kind: 'info', label: 'Build channel', value: 'production' }),
    );
    expect(current?.rows).toContainEqual(
      expect.objectContaining({ kind: 'info', label: 'Running branch', value: 'feat/cool-thing' }),
    );
    // Update ID is truncated to 8 chars, mirroring the original card.
    expect(current?.rows).toContainEqual(
      expect.objectContaining({ kind: 'info', label: 'Update ID', value: 'abcdef12' }),
    );
  });
});
