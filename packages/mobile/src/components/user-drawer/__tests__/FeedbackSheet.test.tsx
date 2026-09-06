// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import type { ManagedSheetHandle } from '../../../providers/sheet-presentation-provider';

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type ModalSheetMockProps = { children?: ReactNode };
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children }: ModalSheetMockProps) => createElement('div', { 'data-modal-sheet': 'true' }, children),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', {}, children),
}));

vi.mock('../../Icon', () => ({
  Icon: () => createElement('span', { 'data-icon': 'true' }),
}));

type ButtonMockProps = { title: string; onPress?: () => void; disabled?: boolean; loading?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: ButtonMockProps) =>
    createElement('button', { onClick: onPress, disabled, 'data-button': title }),
}));

type PressableMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
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
vi.mock('../../../lib/feedback/screenshot-upload', () => ({ uploadFeedbackScreenshots }));

vi.mock('../../settings/SessionRecordingSwitchRow', () => ({
  SessionRecordingSwitchRow: () => createElement('div', { 'data-testid': 'session-recording-switch' }),
}));

// Real tokens.ts pulls in ios-colors.ts, which reads Platform.OS at module load —
// stub the constants FeedbackSheet actually consumes instead of widening the
// react-native mock to support that transitive chain.
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

type SwitchRowMockProps = { label: string; value: boolean; onValueChange: (next: boolean) => void };
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, value, onValueChange }: SwitchRowMockProps) =>
    createElement('button', {
      'data-switch': label,
      'data-value': String(value),
      onClick: () => onValueChange(!value),
    }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', fill: '#eee', separator: '#ccc', label: '#000', tertiaryLabel: '#aaa' },
    brandColors: { warning: '#f90', primary: '#60f' },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast }),
}));

const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated }),
}));

const feedbackMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue(true),
  isPending: false,
  reset: vi.fn(),
}));
vi.mock('../../../lib/feedback/use-submit-app-feedback', () => ({
  useSubmitMobileAppFeedback: () => feedbackMutation,
}));

vi.mock('../../../lib/ble/advertisement-recon', () => ({
  runBleAdvertisementRecon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/discord', () => ({
  openDiscordInvite: vi.fn(),
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

import { FeedbackSheet } from '../FeedbackSheet';

describe('FeedbackSheet bug report contact consent', () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    feedbackMutation.mutateAsync.mockClear();
  });

  const switchRow = (root: HTMLElement) =>
    root.querySelector('[data-switch="feedbackForm.contactConsentLabel"]') as HTMLButtonElement | null;

  it('defaults contact consent to on (opt-out) for an authenticated bug report', () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(switchRow(container)?.getAttribute('data-value')).toBe('true');
  });

  it('does not render the consent switch when unauthenticated', () => {
    auth.isAuthenticated = false;
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(switchRow(container)).toBeNull();
  });

  it('submits contactConsent true by default without the user touching the switch', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
      target: { value: 'the board disconnects on start' },
    });
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(feedbackMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ contactConsent: true }));
  });

  it('respects an explicit opt-out when the reporter flips the switch off', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(switchRow(container)!);
    expect(switchRow(container)?.getAttribute('data-value')).toBe('false');

    fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
      target: { value: 'the board disconnects on start' },
    });
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(feedbackMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ contactConsent: false }));
  });

  it('resets the switch back to on after a successful submit, even from an opt-out', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(switchRow(container)!);
    expect(switchRow(container)?.getAttribute('data-value')).toBe('false');

    fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
      target: { value: 'the board disconnects on start' },
    });
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(switchRow(container)?.getAttribute('data-value')).toBe('true'));
  });

  it('resets the switch back to on when the sheet mode changes away and back', () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, rerender } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(switchRow(container)!);
    expect(switchRow(container)?.getAttribute('data-value')).toBe('false');

    rerender(<FeedbackSheet sheetRef={sheetRef} mode="rating" />);
    rerender(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(switchRow(container)?.getAttribute('data-value')).toBe('true');
  });
});

describe('FeedbackSheet screenshots', () => {
  const picker = (root: HTMLElement) => root.querySelector('[data-screenshot-picker]') as HTMLButtonElement | null;
  const typeReport = (getByPlaceholderText: (text: string) => HTMLElement) => {
    fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
      target: { value: 'the board disconnects on start' },
    });
  };

  beforeEach(() => {
    auth.isAuthenticated = true;
    feedbackMutation.mutateAsync.mockClear().mockResolvedValue(true);
    showToast.mockClear();
    uploadFeedbackScreenshots.mockReset().mockResolvedValue(['feedback-screenshots/one.jpg']);
  });

  it('offers the picker on an authenticated bug report', () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(picker(container)).not.toBeNull();
  });

  it('hides it when signed out — the upload endpoint needs a bearer token', () => {
    auth.isAuthenticated = false;
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(picker(container)).toBeNull();
  });

  it('hides it on the star-rating form, which files no issue to illustrate', () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="rating" />);
    expect(picker(container)).toBeNull();
  });

  it('uploads the picked shots and sends their keys with the report', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(picker(container)!);
    typeReport(getByPlaceholderText);
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);

    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(uploadFeedbackScreenshots).toHaveBeenCalledWith(['file:///shot-0.jpg']);
    expect(feedbackMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotKeys: ['feedback-screenshots/one.jpg'] }),
    );
  });

  it('sends no keys at all when nothing was attached', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    typeReport(getByPlaceholderText);
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);

    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(uploadFeedbackScreenshots).not.toHaveBeenCalled();
    expect(feedbackMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ screenshotKeys: null }));
  });

  it('clears the strip after a successful submit', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(picker(container)!);
    typeReport(getByPlaceholderText);
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);

    await vi.waitFor(() => expect(picker(container)?.getAttribute('data-screenshot-picker')).toBe(''));
  });

  it('clears the strip when the sheet mode changes away and back', () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, rerender } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(picker(container)!);
    expect(picker(container)?.getAttribute('data-screenshot-picker')).toBe('file:///shot-0.jpg');

    rerender(<FeedbackSheet sheetRef={sheetRef} mode="rating" />);
    rerender(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    expect(picker(container)?.getAttribute('data-screenshot-picker')).toBe('');
  });

  it('keeps the typed report and the shots when the upload fails', async () => {
    uploadFeedbackScreenshots.mockRejectedValue(new Error('offline'));
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container, getByPlaceholderText } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);
    fireEvent.click(picker(container)!);
    typeReport(getByPlaceholderText);
    fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.uploadFailed', 'error'));
    expect(feedbackMutation.mutateAsync).not.toHaveBeenCalled();
    expect((getByPlaceholderText('feedbackForm.bugPlaceholder') as HTMLInputElement).value).toBe(
      'the board disconnects on start',
    );
    expect(picker(container)?.getAttribute('data-screenshot-picker')).toBe('file:///shot-0.jpg');
  });
});
