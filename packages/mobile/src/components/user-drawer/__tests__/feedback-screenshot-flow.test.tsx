// @vitest-environment jsdom
//
// Integration test for the seam the two sheet suites mock away: the REAL
// `ScreenshotPicker` rendered inside the REAL `FeedbackSheet`. Only true leaves
// are mocked here — the photo library, the native image manipulator, and the
// upload transport. Everything between them (pick → compress → stage → submit)
// runs for real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import type { ManagedSheetHandle } from '../../../providers/sheet-presentation-provider';

type ViewMockProps = { children?: ReactNode; accessibilityLabel?: string };
type ImageMockProps = { source?: { uri?: string } };
// Widened over FeedbackSheet.test.tsx's View-only mock: the real ScreenshotPicker
// renders thumbnails with `Image` and measures its add tile with hairlineWidth.
vi.mock('react-native', () => ({
  View: ({ children, accessibilityLabel }: ViewMockProps) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
  Image: ({ source }: ImageMockProps) => createElement('img', { 'data-uri': source?.uri }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
  Button: ({ title, onPress, disabled, loading }: ButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      disabled,
      'data-button': title,
      'data-loading': String(Boolean(loading)),
    }),
}));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
};
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, disabled }: PressableMockProps) =>
    createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));

// NOT mocked: ../../feedback/ScreenshotPicker. That is the whole point.

const uploadFeedbackScreenshots = vi.hoisted(() => vi.fn());
const clearScreenshotUploadCache = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/feedback/screenshot-upload', () => ({ uploadFeedbackScreenshots, clearScreenshotUploadCache }));

vi.mock('../../settings/SessionRecordingSwitchRow', () => ({
  SessionRecordingSwitchRow: () => createElement('div', { 'data-testid': 'session-recording-switch' }),
}));

// Real tokens.ts pulls in ios-colors.ts, which reads Platform.OS at module load.
// Covers both consumers: the sheet (spacing 1-6, borderRadius.lg) and the picker
// (borderRadius.md / .full).
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { md: 8, lg: 12, full: 9999 },
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
    systemColors: {
      secondaryLabel: '#888',
      fill: '#eee',
      separator: '#ccc',
      label: '#000',
      tertiaryLabel: '#aaa',
      secondaryBackground: '#f5f5f5',
    },
    brandColors: { warning: '#f90', primary: '#60f' },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast }),
}));

const reportError = vi.hoisted(() => vi.fn());
const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/error-reporting', () => ({ reportError, reportHandledError }));

const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated }),
}));

const feedbackMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
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

// Leaf: the OS photo library.
const imagePicker = vi.hoisted(() => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));
vi.mock('expo-image-picker', () => imagePicker);

// Leaf: the native image manipulator behind the real `compressPickedImage`.
const manipulator = vi.hoisted(() => {
  const state = { saved: 0 };
  const release = vi.fn();
  const saveAsync = vi.fn(() => {
    state.saved += 1;
    return Promise.resolve({ uri: `file:///compressed-${state.saved}.jpg` });
  });
  const renderAsync = vi.fn(() => Promise.resolve({ saveAsync, release }));
  const resize = vi.fn();
  const manipulate = vi.fn(() => ({ resize, renderAsync }));
  return { state, release, saveAsync, renderAsync, resize, manipulate };
});
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: manipulator.manipulate },
  SaveFormat: { JPEG: 'jpeg' },
}));

import { FeedbackSheet } from '../FeedbackSheet';

const REPORT_TEXT = 'the board disconnects on start';

const submitButton = (root: HTMLElement) =>
  root.querySelector('[data-button="feedbackDialog.submitBug"]') as HTMLButtonElement;
const addTile = (root: HTMLElement) => root.querySelector('[aria-label="screenshots.addAria"]') as HTMLButtonElement;
const thumbnails = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('img')).map((image) => image.getAttribute('data-uri'));
const commentInput = (root: HTMLElement) =>
  root.querySelector('input[placeholder="feedbackForm.bugPlaceholder"]') as HTMLInputElement;

describe('bug report with a screenshot, real picker inside the real sheet', () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    showToast.mockClear();
    reportError.mockClear();
    reportHandledError.mockClear();
    feedbackMutation.mutateAsync.mockReset().mockResolvedValue(true);
    feedbackMutation.isPending = false;
    uploadFeedbackScreenshots.mockReset().mockResolvedValue(['feedback-screenshots/one.jpg']);
    clearScreenshotUploadCache.mockClear();
    manipulator.state.saved = 0;
    manipulator.manipulate.mockClear();
    imagePicker.requestMediaLibraryPermissionsAsync.mockReset().mockResolvedValue({ granted: true });
    imagePicker.launchImageLibraryAsync
      .mockReset()
      .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.jpg', width: 1290, height: 2796 }] });
  });

  it('keeps the typed report and a live submit button across the pick, then files it', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    // 1. A long-enough report arms the submit button.
    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    expect(submitButton(container).disabled).toBe(false);

    // 2. Pick one screenshot through the real add tile.
    fireEvent.click(addTile(container));
    await vi.waitFor(() => expect(thumbnails(container)).toEqual(['file:///compressed-1.jpg']));

    // 3. The crux: the pick must not have eaten the report or the button.
    expect(commentInput(container).value).toBe(REPORT_TEXT);
    expect(submitButton(container).disabled).toBe(false);

    // 4. Submit uploads the staged shot and files the report with its key.
    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(uploadFeedbackScreenshots).toHaveBeenCalledWith(['file:///compressed-1.jpg']);
    expect(feedbackMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ comment: REPORT_TEXT, screenshotKeys: ['feedback-screenshots/one.jpg'] }),
    );
  });

  it('leaves the button live when the reporter types after picking', async () => {
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    fireEvent.click(addTile(container));
    await vi.waitFor(() => expect(thumbnails(container)).toEqual(['file:///compressed-1.jpg']));

    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    expect(submitButton(container).disabled).toBe(false);

    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(feedbackMutation.mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('toasts and re-arms the button when the pick itself blows up', async () => {
    imagePicker.launchImageLibraryAsync.mockRejectedValue(new Error('library unavailable'));
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.pickFailed', 'error'));
    expect(commentInput(container).value).toBe(REPORT_TEXT);
    expect(submitButton(container).disabled).toBe(false);
  });

  it('still shows the picker and a live button when permission is denied', async () => {
    imagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.permissionDenied', 'warning'));
    expect(thumbnails(container)).toEqual([]);
    expect(submitButton(container).disabled).toBe(false);
  });
});

describe('an upload that never settles', () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    showToast.mockClear();
    feedbackMutation.mutateAsync.mockReset().mockResolvedValue(true);
    feedbackMutation.isPending = false;
    clearScreenshotUploadCache.mockClear();
    manipulator.state.saved = 0;
    imagePicker.requestMediaLibraryPermissionsAsync.mockReset().mockResolvedValue({ granted: true });
    imagePicker.launchImageLibraryAsync
      .mockReset()
      .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.jpg', width: 1290, height: 2796 }] });
  });

  it('re-arms the button when the upload REJECTS — the differential against a stall', async () => {
    uploadFeedbackScreenshots.mockReset().mockRejectedValue(new Error('offline'));
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    fireEvent.click(addTile(container));
    await vi.waitFor(() => expect(thumbnails(container)).toEqual(['file:///compressed-1.jpg']));

    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.uploadFailed', 'error'));
    await vi.waitFor(() => expect(submitButton(container).disabled).toBe(false));
    expect(submitButton(container).getAttribute('data-loading')).toBe('false');

    // A second tap really does retry.
    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(uploadFeedbackScreenshots).toHaveBeenCalledTimes(2));
  });

  it('parks the submit button in a permanent loading state with no toast', async () => {
    // The 30s deadline on each request covers a stalled FETCH. It cannot cover a
    // stall EARLIER than the fetch — reading the picked file through Expo's
    // shared serial queue — which is the shape that caused #5197. Model that
    // worst case as a promise that never settles, and pin what the sheet does.
    uploadFeedbackScreenshots.mockReset().mockReturnValue(new Promise<string[]>(() => {}));
    const sheetRef = createRef<ManagedSheetHandle>();
    const { container } = render(<FeedbackSheet sheetRef={sheetRef} mode="bug" />);

    fireEvent.change(commentInput(container), { target: { value: REPORT_TEXT } });
    fireEvent.click(addTile(container));
    await vi.waitFor(() => expect(thumbnails(container)).toEqual(['file:///compressed-1.jpg']));

    fireEvent.click(submitButton(container));
    await vi.waitFor(() => expect(submitButton(container).getAttribute('data-loading')).toBe('true'));
    expect(submitButton(container).disabled).toBe(true);

    // Let every pending microtask and timer drain — nothing rescues it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(submitButton(container).getAttribute('data-loading')).toBe('true');
    expect(submitButton(container).disabled).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
    expect(feedbackMutation.mutateAsync).not.toHaveBeenCalled();

    // And it cannot be retried: the guard in handleSubmit early-returns while
    // `isUploading` is true, and the button is disabled anyway.
    fireEvent.click(submitButton(container));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploadFeedbackScreenshots).toHaveBeenCalledTimes(1);
    expect(feedbackMutation.mutateAsync).not.toHaveBeenCalled();
  });
});
