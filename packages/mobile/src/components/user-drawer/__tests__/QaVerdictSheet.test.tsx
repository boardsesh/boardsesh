// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import type { ManagedSheetHandle } from '../../../providers/sheet-presentation-provider';

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// The real ModalSheet mounts @expo/ui's native bottom sheet. Capture its
// dismiss/onFullyDismissed wiring instead: the ORDER of those two is the whole
// point of the surf-after-dismiss rule.
const sheet = vi.hoisted(() => ({
  dismiss: vi.fn(),
  fullyDismissed: null as (() => void) | null,
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, onFullyDismissed }: { children?: ReactNode; onFullyDismissed?: () => void }) => {
    sheet.fullyDismissed = onFullyDismissed ?? null;
    return createElement('div', { 'data-modal-sheet': 'true' }, children);
  },
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', {}, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

type ButtonMockProps = { title: string; onPress?: () => void; disabled?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: ButtonMockProps) =>
    createElement('button', { onClick: onPress, disabled, 'data-button': title }),
}));

type PressableMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

type SegmentedMockProps = {
  options: { key: string; label: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
};
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect }: SegmentedMockProps) =>
    createElement(
      'div',
      { 'data-segmented': selectedKey },
      options.map((option) =>
        createElement('button', {
          key: option.key,
          'data-segment': option.key,
          onClick: () => onSelect(option.key),
        }),
      ),
    ),
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value: value ?? '',
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12, full: 9999 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', fill: '#eee', separator: '#ccc', label: '#000', tertiaryLabel: '#aaa' },
    brandColors: { success: '#0a0', error: '#a00', onPrimary: '#fff' },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolates `{{name}}` like the real `t`, so assertions on toasts and
    // labels match the string a tester actually reads.
    t: (key: string, values?: Record<string, unknown>) => {
      const template =
        {
          'actions.close': 'Close',
          'qa.shared.backOnProduction': 'Back on production at the next update',
          'qa.shared.leaveFailed': 'Could not switch off this preview — try again',
          'qa.verdict.sheetTitle': 'How did it go?',
          'qa.verdict.approveLabel': 'Approve',
          'qa.verdict.declineLabel': 'Decline',
          'qa.verdict.verdictGroupLabel': 'Verdict',
          'qa.verdict.approvePlaceholder': 'Anything worth noting? (optional)',
          'qa.verdict.declinePlaceholder': 'What went wrong? Steps help.',
          'qa.verdict.submitLabel': 'Send verdict',
          'qa.verdict.leaveLabel': 'Leave preview without feedback',
          'qa.verdict.submitError': 'Could not send that verdict — try again',
          'qa.verdict.notOnPreview': "You're on production — nothing to file a verdict on.",
          'qa.verdict.verdictSentToast': 'Verdict sent to #{{prNumber}}',
          'qa.verdict.moreCharsNeeded': '{{count}} more characters needed',
        }[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));

const setSettingMock = vi.hoisted(() => vi.fn());
vi.mock('../../../settings', () => ({ setSetting: setSettingMock }));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

const qa = vi.hoisted(() => ({
  runningPrNumber: 4792 as number | null,
  surfingAvailable: true,
  surfToProduction: vi.fn(),
}));
vi.mock('../../../lib/qa/qa-surf', () => ({
  qaSurfingAvailable: () => qa.surfingAvailable,
  readRunningPrNumber: () => qa.runningPrNumber,
  surfToProduction: qa.surfToProduction,
}));

const previews = vi.hoisted(() => ({
  data: [{ prNumber: 4792, title: 'Ask testers to try a PR preview', risk: 3 }] as unknown[],
  mutateAsync: vi.fn(),
  // Records the `enabled` option so a test can assert the sheet does not fire a
  // query that needs an account before one is known.
  lastOptions: undefined as { enabled?: boolean } | undefined,
}));
vi.mock('../../../lib/qa/use-qa-previews', () => ({
  useQaPreviews: (_prNumbers: number[], options?: { enabled?: boolean }) => {
    previews.lastOptions = options;
    return { data: previews.data, isPending: false };
  },
  useSubmitQaVerdict: () => ({ mutateAsync: previews.mutateAsync, isPending: false }),
}));

const profileState = vi.hoisted(() => ({ id: 'user-1' as string | undefined, isTester: true as boolean | undefined }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: profileState.id, isTester: profileState.isTester } }),
}));

vi.mock('expo-updates', () => ({ updateId: 'bundle-a' }));

import { QaVerdictSheet } from '../QaVerdictSheet';

function renderSheet() {
  const sheetRef = createRef<ManagedSheetHandle>();
  // The provider owns the ref; stand in for the imperative handle the real
  // ModalSheet installs.
  (sheetRef as { current: ManagedSheetHandle | null }).current = {
    present: vi.fn(),
    dismiss: sheet.dismiss,
  } as unknown as ManagedSheetHandle;
  return { sheetRef, ...render(<QaVerdictSheet sheetRef={sheetRef} />) };
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-button="Send verdict"]') as HTMLButtonElement;
}

beforeEach(() => {
  sheet.dismiss.mockClear();
  sheet.fullyDismissed = null;
  showToast.mockClear();
  setSettingMock.mockClear();
  trackMock.mockClear();
  reportHandledErrorMock.mockClear();
  qa.runningPrNumber = 4792;
  qa.surfingAvailable = true;
  qa.surfToProduction.mockReset().mockResolvedValue('nothing-to-load');
  previews.data = [{ prNumber: 4792, title: 'Ask testers to try a PR preview', risk: 3 }];
  previews.mutateAsync.mockReset().mockResolvedValue({ id: 'verdict-1' });
  previews.lastOptions = undefined;
  profileState.id = 'user-1';
  profileState.isTester = true;
});

describe('QaVerdictSheet approve path', () => {
  it('sends an approval with no comment required', async () => {
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledTimes(1));
    expect(previews.mutateAsync).toHaveBeenCalledWith({
      prNumber: 4792,
      branch: 'pr-4792',
      verdict: 'approved',
      comment: null,
    });
  });

  it('remembers the bundle it signed off, so the gate stops re-prompting', async () => {
    // Leaving a preview usually can't reload the app; this marker is what keeps
    // the launch gate and the drawer quiet afterwards.
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() =>
      // Account-scoped: the settings store is device-wide, so a marker that
      // named only the branch and bundle hid the row from the next tester too.
      expect(setSettingMock).toHaveBeenCalledWith('qaVerdictSubmittedKey', 'user-1:pr-4792:bundle-a'),
    );
    expect(trackMock).toHaveBeenCalledWith('QA Verdict Submitted', { prNumber: 4792, verdict: 'approved', risk: 3 });
    expect(showToast).toHaveBeenCalledWith('Verdict sent to #4792', 'success');
  });

  it('leaves the preview only once the sheet has fully dismissed', async () => {
    // A reload mid-dismissal would tear down a live native presentation.
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(sheet.dismiss).toHaveBeenCalled());
    expect(qa.surfToProduction).not.toHaveBeenCalled();

    sheet.fullyDismissed?.();
    expect(qa.surfToProduction).toHaveBeenCalledTimes(1);
  });

  it('stays on the sheet when the verdict does not reach the backend', async () => {
    previews.mutateAsync.mockRejectedValue(new Error('offline'));
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not send that verdict — try again', 'error'));
    expect(sheet.dismiss).not.toHaveBeenCalled();
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).toHaveBeenCalled();
  });
});

describe('QaVerdictSheet decline path', () => {
  function decline(container: HTMLElement) {
    fireEvent.click(container.querySelector('[data-segment="declined"]')!);
  }

  it('will not send a decline without an explanation', () => {
    // "It broke" with no detail is not a bug report anyone can act on.
    const { container } = renderSheet();
    decline(container);
    expect(submitButton(container).disabled).toBe(true);
  });

  it('still refuses a decline whose comment is only whitespace-padded', () => {
    const { container, getByPlaceholderText } = renderSheet();
    decline(container);
    fireEvent.change(getByPlaceholderText('What went wrong? Steps help.'), { target: { value: '   short   ' } });
    expect(submitButton(container).disabled).toBe(true);
  });

  it('sends the trimmed comment once it is long enough', async () => {
    const { container, getByPlaceholderText } = renderSheet();
    decline(container);
    fireEvent.change(getByPlaceholderText('What went wrong? Steps help.'), {
      target: { value: '  the board never lights up  ' },
    });
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledTimes(1));
    expect(previews.mutateAsync).toHaveBeenCalledWith({
      prNumber: 4792,
      branch: 'pr-4792',
      verdict: 'declined',
      comment: 'the board never lights up',
    });
  });
});

describe('QaVerdictSheet leaving without a verdict', () => {
  it('surfs back only after the dismissal settles', () => {
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-button="Leave preview without feedback"]')!);

    expect(trackMock).toHaveBeenCalledWith('QA Preview Left', { prNumber: 4792 });
    expect(sheet.dismiss).toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();

    sheet.fullyDismissed?.();
    expect(qa.surfToProduction).toHaveBeenCalledTimes(1);
  });

  it('disables both surf actions on a build that cannot surf', () => {
    // A dev build can open the sheet; it just cannot switch bundles.
    qa.surfingAvailable = false;
    const { container } = renderSheet();
    expect(
      (container.querySelector('[data-button="Leave preview without feedback"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('QaVerdictSheet without an account', () => {
  it('will not file a verdict it could not attribute', () => {
    // `myLatestVerdict` is per-caller and the "already signed off" marker is
    // account-scoped, so a verdict filed before we know who is signed in would
    // leave a marker nobody owns.
    profileState.id = undefined;
    const { container } = renderSheet();
    expect(submitButton(container).disabled).toBe(true);
  });
});

describe('QaVerdictSheet on production', () => {
  it('cannot file a verdict when no preview is running', () => {
    qa.runningPrNumber = null;
    const { container } = renderSheet();
    expect(submitButton(container).disabled).toBe(true);
  });
});

// This sheet is mounted at the UserDrawerProvider root for the whole app session,
// so its query runs at launch whether or not anyone opens it.
describe('QaVerdictSheet query gating', () => {
  it('asks for PR metadata once an account is known', () => {
    renderSheet();
    expect(previews.lastOptions).toEqual({ enabled: true });
  });

  it('asks for it for a non-tester too, since anyone can file a verdict', () => {
    profileState.isTester = false;
    renderSheet();
    expect(previews.lastOptions).toEqual({ enabled: true });
  });

  it('asks for nothing while no account is known', () => {
    // The sheet is mounted at the provider root for the whole session, so an
    // ungated query is one rejected request per cold start for anyone signed
    // out — and `qaPreviews` needs an account.
    profileState.id = undefined;
    renderSheet();
    expect(previews.lastOptions).toEqual({ enabled: false });
  });
});

describe('QaVerdictSheet when the surf back fails', () => {
  it('blames the pin, not the verdict, and carries the reason to the event', async () => {
    // The verdict is already filed and toasted by the time this can fire —
    // "could not send that verdict" would be a lie about which half broke. The
    // raw message goes to the event, never into the tester's face.
    qa.surfToProduction.mockRejectedValue(new Error('Could not reach the update server (502).'));
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(sheet.dismiss).toHaveBeenCalled());
    sheet.fullyDismissed?.();

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not switch off this preview — try again', 'error'),
    );
    expect(showToast).not.toHaveBeenCalledWith('Could not send that verdict — try again', 'error');
    expect(trackMock).toHaveBeenCalledWith('QA Surf Failed', {
      prNumber: null,
      reason: 'Could not reach the update server (502).',
    });
  });
});
