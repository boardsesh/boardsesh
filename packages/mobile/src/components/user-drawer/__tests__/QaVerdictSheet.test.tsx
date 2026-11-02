// @vitest-environment jsdom
vi.mock('../../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, useImperativeHandle, useRef, type ReactNode, type RefObject } from 'react';
import {
  SHEET_SETTLE_MS,
  SheetPresentationProvider,
  useManagedSheet,
  type DismissAndWaitResult,
  type ManagedSheetHandle,
} from '../../../providers/sheet-presentation-provider';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// The real ModalSheet mounts @expo/ui's native bottom sheet. Capture its
// dismiss/onFullyDismissed wiring instead: the ORDER of those two is the whole
// point of the surf-after-dismiss rule.
const sheet = vi.hoisted(() => ({
  present: vi.fn(),
  dismiss: vi.fn(),
  dismissAndWait: vi.fn<() => Promise<DismissAndWaitResult>>(),
  isOpen: true,
  dismissWaiters: [] as ((result: DismissAndWaitResult) => void)[],
  fullyDismissed: null as (() => void) | null,
  onFullyDismissed: null as (() => void) | null,
  nativeChange: null as ((index: number) => void) | null,
  nativeFullyDismissed: null as (() => void) | null,
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({
    children,
    header,
    onFullyDismissed,
  }: {
    children?: ReactNode;
    header?: ReactNode;
    onFullyDismissed?: () => void;
  }) => {
    sheet.onFullyDismissed = onFullyDismissed ?? null;
    return createElement('div', { 'data-modal-sheet': 'true' }, header, children);
  },
}));
const actions = vi.hoisted(() => ({
  leave: null as (() => void) | null,
  submit: null as (() => void) | null,
}));
vi.mock('../../SheetTopBar', async () => {
  const { sheetTopBarModule } = await import('../../../test/sheet-top-bar-stub');
  return {
    SheetTopBar: (props: Parameters<typeof sheetTopBarModule.SheetTopBar>[0]) => {
      actions.submit = props.trailing?.onPress ?? null;
      return createElement(sheetTopBarModule.SheetTopBar, props);
    },
  };
});

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', {}, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

type ButtonMockProps = { title: string; onPress?: () => void; disabled?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: ButtonMockProps) => {
    if (title === 'Leave preview without feedback') actions.leave = onPress ?? null;
    return createElement('button', { onClick: onPress, disabled, 'data-button': title });
  },
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

// The picker owns the photo library + compression; the sheet only cares that it
// hands back URIs and that the keys reach the mutation.
type ScreenshotPickerMockProps = { uris: string[]; onChange: (uris: string[]) => void; disabled?: boolean };
vi.mock('../../feedback/ScreenshotPicker', () => ({
  ScreenshotPicker: ({ uris, onChange, disabled }: ScreenshotPickerMockProps) =>
    createElement('button', {
      'data-screenshot-picker': uris.join(','),
      disabled,
      onClick: () => onChange([...uris, `file:///shot-${uris.length}.jpg`]),
    }),
}));

const uploadFeedbackScreenshots = vi.hoisted(() => vi.fn());
const clearScreenshotUploadCache = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/feedback/screenshot-upload', () => ({ uploadFeedbackScreenshots, clearScreenshotUploadCache }));

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
      // i18next picks the `_one`/`_other` variant from `count`; mirror that
      // here rather than hardcoding one form, so a test can't drift from the
      // pluralization the real catalog enforces.
      if (key === 'qa.verdict.moreCharsNeeded') {
        const count = Number(values?.count ?? 0);
        const template = count === 1 ? '{{count}} more character needed' : '{{count}} more characters needed';
        return template.replace('{{count}}', String(count));
      }
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
          'qa.verdict.submitLabel': 'Send',
          'qa.verdict.leaveLabel': 'Leave preview without feedback',
          'qa.verdict.submitError': 'Could not send that verdict — try again',
          'qa.verdict.notOnPreview': "You're on production — nothing to file a verdict on.",
          'qa.verdict.verdictSentToast': 'Verdict sent to #{{prNumber}}',
          'screenshots.uploadFailed': 'Could not upload your screenshots',
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

// Membership of "Get updates early", and what leaving a preview does for a
// member, are covered where they live (use-early-updates, early-updates,
// ota-track-sequences). Here only what the screen does with the answer matters,
// so `returnToOwnTrack` keeps its contract: production for everyone else, a
// no-reload switch to early updates for a member.
const earlyUpdates = vi.hoisted(() => ({
  member: false,
  joinEarlyUpdates: vi.fn(),
  noteBranchSurfingOff: vi.fn(),
}));
vi.mock('../../../lib/qa/use-early-updates', () => ({ useEarlyUpdatesMember: () => earlyUpdates.member }));
vi.mock('../../../lib/qa/early-updates', () => ({
  returnToOwnTrack: async (member: boolean) => (member ? earlyUpdates.joinEarlyUpdates() : qa.surfToProduction()),
  noteBranchSurfingOff: earlyUpdates.noteBranchSurfingOff,
}));

const previews = vi.hoisted(() => ({
  data: [{ prNumber: 4792, title: 'Ask testers to try a PR preview', risk: 3 }] as unknown[],
  mutateAsync: vi.fn(),
  isPending: false,
  // Records the `enabled` option so a test can assert the sheet does not fire a
  // query that needs an account before one is known.
  lastOptions: undefined as { enabled?: boolean } | undefined,
}));
vi.mock('../../../lib/qa/use-qa-previews', () => ({
  useQaPreviews: (_prNumbers: number[], options?: { enabled?: boolean }) => {
    previews.lastOptions = options;
    return { data: previews.data, isPending: false };
  },
  useSubmitQaVerdict: () => ({ mutateAsync: previews.mutateAsync, isPending: previews.isPending }),
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
    present: sheet.present,
    dismiss: sheet.dismiss,
    dismissAndWait: sheet.dismissAndWait,
  } as unknown as ManagedSheetHandle;
  return { sheetRef, ...render(<QaVerdictSheet sheetRef={sheetRef} />) };
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-button="Send"]') as HTMLButtonElement;
}

beforeEach(() => {
  sheet.present.mockClear();
  sheet.dismiss.mockClear();
  sheet.isOpen = true;
  sheet.dismissWaiters = [];
  sheet.onFullyDismissed = null;
  sheet.nativeChange = null;
  sheet.nativeFullyDismissed = null;
  sheet.fullyDismissed = () => {
    sheet.isOpen = false;
    const waiters = sheet.dismissWaiters.splice(0);
    for (const resolve of waiters) resolve({ status: 'dismissed' });
    sheet.onFullyDismissed?.();
  };
  sheet.dismissAndWait.mockReset().mockImplementation(() => {
    if (!sheet.isOpen) return Promise.resolve({ status: 'dismissed' });
    sheet.dismiss();
    return new Promise((resolve) => sheet.dismissWaiters.push(resolve));
  });
  actions.leave = null;
  actions.submit = null;
  showToast.mockClear();
  setSettingMock.mockClear();
  trackMock.mockClear();
  reportHandledErrorMock.mockClear();
  qa.runningPrNumber = 4792;
  qa.surfingAvailable = true;
  qa.surfToProduction.mockReset().mockResolvedValue('nothing-to-load');
  earlyUpdates.member = false;
  earlyUpdates.joinEarlyUpdates.mockReset().mockResolvedValue('early-updates-next-launch');
  earlyUpdates.noteBranchSurfingOff.mockReset().mockResolvedValue(undefined);
  previews.data = [{ prNumber: 4792, title: 'Ask testers to try a PR preview', risk: 3 }];
  previews.mutateAsync.mockReset().mockResolvedValue({ id: 'verdict-1' });
  previews.isPending = false;
  previews.lastOptions = undefined;
  profileState.id = 'user-1';
  profileState.isTester = true;
  uploadFeedbackScreenshots.mockReset().mockResolvedValue(['feedback-screenshots/one.jpg']);
});

function pickerButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-screenshot-picker]') as HTMLButtonElement;
}

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
      screenshotKeys: null,
    });
    expect(uploadFeedbackScreenshots).not.toHaveBeenCalled();
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

    await act(async () => sheet.fullyDismissed?.());
    expect(qa.surfToProduction).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Back on production at the next update', 'info'));
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Left', expect.anything());
  });

  it('moves an early-updates member back to early updates once their verdict is in', async () => {
    // Production would be the wrong track for them, and the launch sync stands
    // down while the preview pin is in place.
    earlyUpdates.member = true;
    const { container } = renderSheet();
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(sheet.dismiss).toHaveBeenCalled());
    expect(earlyUpdates.joinEarlyUpdates).not.toHaveBeenCalled();

    await act(async () => sheet.fullyDismissed?.());
    expect(earlyUpdates.joinEarlyUpdates).toHaveBeenCalledOnce();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('qa.shared.backOnEarlyUpdates', 'info'));
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Left', expect.anything());
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

function deferred<Result>() {
  let resolve: (result: Result) => void = () => {
    throw new Error('Deferred promise not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('Deferred promise not initialized');
  };
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function retainedAction(actionName: 'leave' | 'submit'): () => void {
  const action = actions[actionName];
  if (action === null) throw new Error(`Missing ${actionName} action`);
  return action;
}

function leaveButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-button="Leave preview without feedback"]') as HTMLButtonElement;
}

describe('QaVerdictSheet synchronous action ownership', () => {
  it('owns the dismissal gap and the pending return even through retained handlers', async () => {
    const returning = deferred<string>();
    qa.surfToProduction.mockReturnValueOnce(returning.promise);
    const { container } = renderSheet();
    const leave = retainedAction('leave');
    const submit = retainedAction('submit');

    // Both handlers belong to the same render. Disabled buttons cannot protect
    // this gap before React commits their busy state.
    act(() => {
      leave();
      leave();
      submit();
    });
    expect(sheet.dismiss).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
    expect(leaveButton(container).disabled).toBe(true);
    expect(submitButton(container).disabled).toBe(true);

    await act(async () => sheet.fullyDismissed?.());
    act(() => {
      leave();
      submit();
      sheet.fullyDismissed?.();
    });
    expect(qa.surfToProduction).toHaveBeenCalledOnce();
    expect(sheet.dismiss).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    await act(async () => returning.resolve('nothing-to-load'));
    expect(leaveButton(container).disabled).toBe(false);
    expect(submitButton(container).disabled).toBe(false);
  });

  it('keeps submission ownership through mutation, dismissal and return', async () => {
    const verdict = deferred<{ id: string }>();
    const returning = deferred<string>();
    previews.mutateAsync.mockReturnValueOnce(verdict.promise);
    qa.surfToProduction.mockReturnValueOnce(returning.promise);
    renderSheet();
    const leave = retainedAction('leave');
    const submit = retainedAction('submit');

    act(() => {
      submit();
      leave();
      submit();
    });
    expect(previews.mutateAsync).toHaveBeenCalledOnce();
    expect(sheet.dismiss).not.toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();

    await act(async () => verdict.resolve({ id: 'verdict-1' }));
    act(() => {
      submit();
      leave();
    });
    expect(sheet.dismiss).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).toHaveBeenCalledOnce();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
    await act(async () => sheet.fullyDismissed?.());
    act(() => {
      leave();
      submit();
      sheet.fullyDismissed?.();
    });
    expect(qa.surfToProduction).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).toHaveBeenCalledOnce();
    expect(sheet.dismiss).toHaveBeenCalledOnce();
    await act(async () => returning.resolve('nothing-to-load'));
  });

  it('blocks leaving and duplicate submission while screenshot upload is pending', async () => {
    const upload = deferred<string[]>();
    uploadFeedbackScreenshots.mockReturnValueOnce(upload.promise);
    const { container } = renderSheet();
    fireEvent.click(pickerButton(container));
    const leave = retainedAction('leave');
    const submit = retainedAction('submit');

    act(() => {
      submit();
      leave();
      submit();
      sheet.fullyDismissed?.();
    });
    expect(uploadFeedbackScreenshots).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect(sheet.dismiss).not.toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
    await act(async () => upload.reject(new Error('upload interrupted')));
    expect(leaveButton(container).disabled).toBe(false);
    expect(submitButton(container).disabled).toBe(false);
    act(() => submit());
    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledOnce());
    expect(uploadFeedbackScreenshots).toHaveBeenCalledTimes(2);
  });

  it('retained handlers observe the current mutation pending flag', () => {
    const { sheetRef, rerender } = renderSheet();
    const leave = retainedAction('leave');
    const submit = retainedAction('submit');
    previews.isPending = true;
    rerender(<QaVerdictSheet sheetRef={sheetRef} />);

    act(() => {
      leave();
      submit();
      sheet.fullyDismissed?.();
    });
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect(sheet.dismiss).not.toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
  });

  it('releases ownership after a failed return so the same sheet can retry', async () => {
    const returning = deferred<string>();
    qa.surfToProduction.mockReturnValueOnce(returning.promise);
    const { container } = renderSheet();
    const leave = retainedAction('leave');
    act(() => leave());
    await act(async () => sheet.fullyDismissed?.());
    await act(async () => returning.reject(new Error('offline')));

    expect(showToast).toHaveBeenCalledWith('Could not switch off this preview — try again', 'error');
    expect(leaveButton(container).disabled).toBe(false);
    expect(submitButton(container).disabled).toBe(false);
    act(() => leave());
    await act(async () => sheet.fullyDismissed?.());
    await vi.waitFor(() => expect(qa.surfToProduction).toHaveBeenCalledTimes(2));
  });

  it.each(['nothing-to-load', 'early-updates-next-launch'] as const)(
    'releases ownership after %s without restarting',
    async (outcome) => {
      earlyUpdates.member = outcome === 'early-updates-next-launch';
      const returning = deferred<string>();
      const returnToTrack = earlyUpdates.member ? earlyUpdates.joinEarlyUpdates : qa.surfToProduction;
      returnToTrack.mockReturnValueOnce(returning.promise);
      const { container } = renderSheet();
      const leave = retainedAction('leave');
      act(() => leave());
      await act(async () => sheet.fullyDismissed?.());
      await act(async () => returning.resolve(outcome));

      expect(leaveButton(container).disabled).toBe(false);
      expect(submitButton(container).disabled).toBe(false);
      act(() => leave());
      await act(async () => sheet.fullyDismissed?.());
      await vi.waitFor(() => expect(returnToTrack).toHaveBeenCalledTimes(2));
    },
  );

  it('retains ownership after a native reload is accepted', async () => {
    qa.surfToProduction.mockResolvedValueOnce('reloading');
    const { container } = renderSheet();
    const leave = retainedAction('leave');
    const submit = retainedAction('submit');
    act(() => leave());
    await act(async () => sheet.fullyDismissed?.());
    await vi.waitFor(() => expect(trackMock).toHaveBeenCalledWith('QA Preview Left', { prNumber: 4792 }));
    act(() => {
      leave();
      submit();
      sheet.fullyDismissed?.();
    });

    expect(leaveButton(container).disabled).toBe(true);
    expect(submitButton(container).disabled).toBe(true);
    expect(qa.surfToProduction).toHaveBeenCalledOnce();
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect(sheet.dismiss).toHaveBeenCalledOnce();
  });

  it('releases submission ownership when the verdict fails', async () => {
    previews.mutateAsync.mockRejectedValueOnce(new Error('offline'));
    const { container } = renderSheet();
    const submit = retainedAction('submit');
    act(() => submit());
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not send that verdict — try again', 'error'));

    expect(leaveButton(container).disabled).toBe(false);
    expect(submitButton(container).disabled).toBe(false);
    act(() => submit());
    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledTimes(2));
  });

  it('releases ownership after dismissal on a build without surfing', async () => {
    qa.surfingAvailable = false;
    const { container } = renderSheet();
    const submit = retainedAction('submit');
    act(() => submit());
    await vi.waitFor(() => expect(sheet.dismiss).toHaveBeenCalledOnce());
    await act(async () => sheet.fullyDismissed?.());

    expect(qa.surfToProduction).not.toHaveBeenCalled();
    expect(submitButton(container).disabled).toBe(false);
    act(() => submit());
    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledTimes(2));
  });
});

function ManagedVerdictHarness({ sheetRef }: { sheetRef: RefObject<ManagedSheetHandle | null> }) {
  const nativeRef = useRef<BottomSheetMethods | null>({
    snapToIndex: sheet.present,
    dismiss: sheet.dismiss,
  } as unknown as BottomSheetMethods);
  const managed = useManagedSheet({ sheetRef: nativeRef, onFullyDismissed: () => sheet.onFullyDismissed?.() });
  useImperativeHandle(sheetRef, () => managed.handle, [managed.handle]);
  sheet.nativeChange = managed.onChange;
  sheet.nativeFullyDismissed = managed.onFullyDismissed;
  return <QaVerdictSheet sheetRef={sheetRef} />;
}

function renderManagedSheet() {
  const sheetRef = createRef<ManagedSheetHandle>();
  const rendered = render(<ManagedVerdictHarness sheetRef={sheetRef} />, { wrapper: SheetPresentationProvider });
  act(() => {
    sheetRef.current?.present();
    vi.advanceTimersByTime(SHEET_SETTLE_MS);
  });
  return { sheetRef, ...rendered };
}

describe('QaVerdictSheet managed dismissal lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['upload', 'mutation'] as const)(
    'returns after the sheet was already dismissed during pending %s',
    async (pendingPhase) => {
      const upload = deferred<string[]>();
      const verdict = deferred<{ id: string }>();
      if (pendingPhase === 'upload') uploadFeedbackScreenshots.mockReturnValueOnce(upload.promise);
      previews.mutateAsync.mockReturnValueOnce(verdict.promise);
      const { container } = renderManagedSheet();
      if (pendingPhase === 'upload') fireEvent.click(pickerButton(container));
      fireEvent.click(submitButton(container));

      // A real user pan/backdrop close settles before the async verdict. The
      // coordinator must not need another native callback for an absent sheet.
      act(() => {
        sheet.nativeChange?.(-1);
        sheet.nativeFullyDismissed?.();
      });
      expect(qa.surfToProduction).not.toHaveBeenCalled();
      if (pendingPhase === 'upload') await act(async () => upload.resolve(['feedback-screenshots/one.jpg']));
      await act(async () => verdict.resolve({ id: 'verdict-1' }));

      expect(qa.surfToProduction).toHaveBeenCalledOnce();
      expect(sheet.dismiss).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('Verdict sent to #4792', 'success');
      expect(submitButton(container).disabled).toBe(false);
    },
  );

  it('releases ownership when reopening aborts an in-flight managed dismissal', async () => {
    const { container, sheetRef } = renderManagedSheet();
    fireEvent.click(leaveButton(container));
    expect(sheet.dismiss).toHaveBeenCalledOnce();
    await act(async () => sheetRef.current?.present());

    expect(qa.surfToProduction).not.toHaveBeenCalled();
    expect(leaveButton(container).disabled).toBe(false);
    expect(submitButton(container).disabled).toBe(false);
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
      screenshotKeys: null,
    });
  });
});

describe('QaVerdictSheet leaving without a verdict', () => {
  it('closes the form without filing a verdict or leaving the preview', async () => {
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-testid="sheet-top-bar-leading"]')!);
    expect(sheet.dismiss).toHaveBeenCalledTimes(1);
    sheet.fullyDismissed?.();
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
  });

  it('surfs back only after the dismissal settles', async () => {
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-button="Leave preview without feedback"]')!);

    expect(trackMock).not.toHaveBeenCalled();
    expect(sheet.dismiss).toHaveBeenCalled();
    expect(qa.surfToProduction).not.toHaveBeenCalled();

    await act(async () => sheet.fullyDismissed?.());
    expect(qa.surfToProduction).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(trackMock).toHaveBeenCalledExactlyOnceWith('QA Preview Left', { prNumber: 4792 }));
    await act(async () => sheet.fullyDismissed?.());
    expect(qa.surfToProduction).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('does not count a leave while its dismissed return is still pending', async () => {
    let settleReturn!: (outcome: string) => void;
    qa.surfToProduction.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        settleReturn = resolve;
      }),
    );
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-button="Leave preview without feedback"]')!);
    sheet.fullyDismissed?.();

    await vi.waitFor(() => expect(qa.surfToProduction).toHaveBeenCalledOnce());
    expect(trackMock).not.toHaveBeenCalled();

    settleReturn('reloading');
    await vi.waitFor(() => expect(trackMock).toHaveBeenCalledExactlyOnceWith('QA Preview Left', { prNumber: 4792 }));
  });

  it('counts a refused leave only as failure, even when a verdict follows', async () => {
    const reason = 'No safe production update is available; the preview pin is still active.';
    qa.surfToProduction.mockRejectedValueOnce(new Error(reason));
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-button="Leave preview without feedback"]')!);
    sheet.fullyDismissed?.();

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not switch off this preview — try again', 'error'),
    );
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('QA Surf Failed', { prNumber: null, reason });

    // The sheet persists across opens; a refused no-feedback attempt must not
    // classify the next successful verdict as leaving without feedback.
    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(trackMock).toHaveBeenCalledWith('QA Verdict Submitted', expect.anything()));
    sheet.fullyDismissed?.();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Back on production at the next update', 'info'));
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Left', expect.anything());
  });

  it('counts a successful no-feedback return to early updates', async () => {
    earlyUpdates.member = true;
    const { container } = renderSheet();
    fireEvent.click(container.querySelector('[data-button="Leave preview without feedback"]')!);
    expect(trackMock).not.toHaveBeenCalled();
    sheet.fullyDismissed?.();

    await vi.waitFor(() => expect(trackMock).toHaveBeenCalledExactlyOnceWith('QA Preview Left', { prNumber: 4792 }));
    expect(earlyUpdates.joinEarlyUpdates).toHaveBeenCalledOnce();
    expect(qa.surfToProduction).not.toHaveBeenCalled();
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

describe('QaVerdictSheet screenshots', () => {
  it('uploads the picked shots and files their keys with the verdict', async () => {
    const { container } = renderSheet();
    fireEvent.click(pickerButton(container));
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(previews.mutateAsync).toHaveBeenCalledTimes(1));
    expect(uploadFeedbackScreenshots).toHaveBeenCalledWith(['file:///shot-0.jpg']);
    expect(previews.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotKeys: ['feedback-screenshots/one.jpg'] }),
    );
  });

  it('clears the strip after a successful send, so the next verdict starts empty', async () => {
    // This sheet lives at the UserDrawerProvider root for the whole app session
    // and is never remounted — a missed reset leaks the last report's shots.
    const { container } = renderSheet();
    fireEvent.click(pickerButton(container));
    expect(pickerButton(container).getAttribute('data-screenshot-picker')).toBe('file:///shot-0.jpg');

    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(pickerButton(container).getAttribute('data-screenshot-picker')).toBe(''));
  });

  it('keeps the typed comment and the shots when the upload fails', async () => {
    uploadFeedbackScreenshots.mockRejectedValue(new Error('offline'));
    const { container, getByPlaceholderText } = renderSheet();
    fireEvent.change(getByPlaceholderText('Anything worth noting? (optional)'), {
      target: { value: 'the wall lit the wrong holds' },
    });
    fireEvent.click(pickerButton(container));
    fireEvent.click(submitButton(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not upload your screenshots', 'error'));
    expect(previews.mutateAsync).not.toHaveBeenCalled();
    expect((getByPlaceholderText('Anything worth noting? (optional)') as HTMLInputElement).value).toBe(
      'the wall lit the wrong holds',
    );
    expect(pickerButton(container).getAttribute('data-screenshot-picker')).toBe('file:///shot-0.jpg');
    expect(sheet.dismiss).not.toHaveBeenCalled();
  });
});
