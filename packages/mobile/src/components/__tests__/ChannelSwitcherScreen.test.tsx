// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitcherFormModel, SwitcherTargetRow } from '../SwitcherForm.types';

// Capture the view-model the screen hands to the native form, so we can assert the
// refactor preserves the sections, the public-vs-tester gating, and the preview-row
// mapping without mounting a native @expo/ui tree.
//
// NOTE: the mobile vitest config inlines `__DEV__: true` (a `define`, not a global),
// so `updatesUsable = Updates.isEnabled && !__DEV__` is always false under test.
// The OTA-switch-gated sections (preset / manual / reset) therefore can't render
// here, and target rows resolve to the non-pressable `inert` state. That gating and
// the switch flow itself are covered by `channel-switch.test.ts` +
// `switcher-form-logic.test.ts` + manual on-device QA; this suite locks the
// model-building, the signed-out preview list, and the tester gating.
//
// Same reason the deep-link (`requestedChannel`) guards live in
// `resolveRequestedChannelAction` and are tested in `channel-switch.test.ts`:
// 'switch' is unreachable here. What this suite CAN pin is that the inert case
// stays inert — no dialog on a build that couldn't act on it anyway.
const captured = vi.hoisted(() => ({ model: null as SwitcherFormModel | null }));
const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const hooksState = vi.hoisted(() => ({
  isTester: false,
  previewChannels: [{ channel: 'pr-100', title: 'Fix the thing' }],
  isLoading: false,
  isError: false,
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('expo-updates', () => ({
  channel: 'production',
  runtimeVersion: '1.0.0',
  isEnabled: true,
  isEmbeddedLaunch: false,
  manifest: null,
  updateId: null,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../../lib/sentry', () => ({ isSentryEnabled: false, nativeSentryCrash: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../lib/preference-store', () => ({
  getPreference: vi.fn().mockResolvedValue(null),
  setPreference: vi.fn(),
  removePreference: vi.fn(),
}));
vi.mock('../../lib/apply-channel-override', () => ({ applyChannelOverride: vi.fn() }));

vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { isTester: hooksState.isTester } }),
  useOtaPreviewChannels: () => ({
    data: hooksState.previewChannels,
    isLoading: hooksState.isLoading,
    isError: hooksState.isError,
  }),
}));

vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));

vi.mock('../SwitcherForm', () => ({
  SwitcherForm: ({ model }: { model: SwitcherFormModel }) => {
    captured.model = model;
    return null;
  },
}));

import { ChannelSwitcherScreen } from '../ChannelSwitcherScreen';

function sectionKeys(model: SwitcherFormModel): string[] {
  return model.sections.map((section) => section.key);
}

function targetRow(model: SwitcherFormModel, sectionKey: string, rowKey: string): SwitcherTargetRow | undefined {
  const row = model.sections
    .find((section) => section.key === sectionKey)
    ?.rows.find((candidate) => candidate.key === rowKey);
  return row?.kind === 'target' ? row : undefined;
}

beforeEach(() => {
  captured.model = null;
  confirmMock.mockClear();
  hooksState.isTester = false;
  hooksState.previewChannels = [{ channel: 'pr-100', title: 'Fix the thing' }];
  hooksState.isLoading = false;
  hooksState.isError = false;
});

describe('ChannelSwitcherScreen', () => {
  it('shows a signed-out, non-tester user the current + preview sections with the live PR row', () => {
    render(createElement(ChannelSwitcherScreen));

    const model = captured.model;
    expect(model).not.toBeNull();
    if (!model) return;

    expect(sectionKeys(model)).toEqual(['current', 'preview']);
    // No tester-only surfaces leak to a non-tester.
    expect(sectionKeys(model)).not.toContain('preset');
    expect(sectionKeys(model)).not.toContain('sentry');

    // The build channel is surfaced, and the live PR preview row is rendered.
    const current = model.sections.find((section) => section.key === 'current');
    expect(current?.rows).toContainEqual(expect.objectContaining({ kind: 'info', value: 'production' }));
    const previewRow = targetRow(model, 'preview', 'pr-100');
    expect(previewRow?.title).toBe('Fix the thing');
    expect(previewRow?.subtitle).toBe('pr-100');
    expect(previewRow?.showChevronWhenPressable).toBe(true);

    // The fixed Production row heads the preview list so everyone has a route home,
    // even signed out. On the build channel (no override) it's the active row.
    const productionRow = targetRow(model, 'preview', 'production');
    expect(productionRow?.title).toBe('mobile.previewChannels.productionTitle');
    expect(productionRow?.state).toBe('active');
  });

  it('renders the preview list when the backend query is empty', () => {
    hooksState.previewChannels = [];
    render(createElement(ChannelSwitcherScreen));

    const preview = captured.model?.sections.find((section) => section.key === 'preview');
    // The fixed Production row always leads; the empty-state status row follows.
    expect(preview?.rows).toEqual([
      expect.objectContaining({ kind: 'target', key: 'production' }),
      expect.objectContaining({ kind: 'status', label: 'mobile.previewChannels.empty' }),
    ]);
  });

  it('surfaces the error status when the backend query fails', () => {
    // The error branch is also the non-tester fallback that adds a `manual` section,
    // but that section is `updatesUsable`-gated (false under test __DEV__), so only
    // the preview error-status row is observable here.
    hooksState.isError = true;
    render(createElement(ChannelSwitcherScreen));

    const preview = captured.model?.sections.find((section) => section.key === 'preview');
    // The fixed Production row always leads; the error-status row follows.
    expect(preview?.rows).toEqual([
      expect.objectContaining({ kind: 'target', key: 'production' }),
      expect.objectContaining({ kind: 'status', label: 'mobile.previewChannels.error' }),
    ]);
  });

  it('renders the same model with or without a deep-linked channel', () => {
    // The route passes requestedChannel through; it must not disturb the sections
    // a plain /channel-switcher visit builds.
    render(createElement(ChannelSwitcherScreen));
    const withoutRequest = captured.model;

    render(createElement(ChannelSwitcherScreen, { requestedChannel: 'pr-100' }));
    const withRequest = captured.model;

    expect(withoutRequest).not.toBeNull();
    expect(withRequest).not.toBeNull();
    if (!withoutRequest || !withRequest) return;
    expect(sectionKeys(withRequest)).toEqual(sectionKeys(withoutRequest));
  });

  it('raises no confirm dialog for a deep-linked channel when switching is inert', () => {
    // updatesUsable is false under test (__DEV__ is inlined true), so the request
    // must resolve to the prefill branch. A dialog here would be a prompt the user
    // cannot act on.
    render(createElement(ChannelSwitcherScreen, { requestedChannel: 'pr-100' }));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('adds the Sentry section for a tester (gated on the profile, not OTA usability)', () => {
    hooksState.isTester = true;
    render(createElement(ChannelSwitcherScreen));

    const model = captured.model;
    expect(model).not.toBeNull();
    if (!model) return;

    expect(sectionKeys(model)).toContain('sentry');
    expect(sectionKeys(model)).not.toContain('preset'); // OTA-gated; unavailable under test __DEV__
  });
});
