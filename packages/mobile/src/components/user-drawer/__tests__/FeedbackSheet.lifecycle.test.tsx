// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, fireEvent, act } from '@testing-library/react';
import { createElement, createRef, useSyncExternalStore, Profiler, useState, type ReactNode } from 'react';
import type { ManagedSheetHandle } from '../../../providers/sheet-presentation-provider';

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type ModalSheetMockProps = { children?: ReactNode; visible?: boolean; onClose?: () => void };
const nativeSheet = vi.hoisted(() => ({ close: undefined as (() => void) | undefined }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, visible, onClose }: ModalSheetMockProps) => {
    nativeSheet.close = onClose;
    return createElement('div', { 'data-modal-sheet': String(visible) }, children);
  },
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
const clearScreenshotUploadCache = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/feedback/screenshot-upload', () => ({ uploadFeedbackScreenshots, clearScreenshotUploadCache }));

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

const request = vi.hoisted(() => vi.fn().mockResolvedValue({ submitAppFeedback: true }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '2.5.0', nativeBuildVersion: '1' }));

const metadata = vi.hoisted(() => ({
  pathname: '/home',
  sessionId: 'session-before',
  climbUuid: 'climb-before',
  boardName: 'kilter',
  revision: 0,
  listeners: new Set<() => void>(),
  subscriptions: 0,
}));
function subscribeMetadata(listener: () => void) {
  metadata.listeners.add(listener);
  metadata.subscriptions++;
  return () => {
    metadata.listeners.delete(listener);
    metadata.subscriptions--;
  };
}
function useMetadataRevision() {
  useSyncExternalStore(subscribeMetadata, () => metadata.revision);
}
function updateMetadata() {
  metadata.revision++;
  for (const listener of metadata.listeners) listener();
}
vi.mock('expo-router', () => ({
  usePathname: () => {
    useMetadataRevision();
    return metadata.pathname;
  },
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => {
    useMetadataRevision();
    return { data: { boardType: metadata.boardName, layoutId: 1, sizeId: 2, setIds: '1', angle: 40 } };
  },
}));
const queueActions = { getQueueSnapshot: () => ({ currentClimbQueueItem: { climb: { uuid: metadata.climbUuid } } }) };
vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => {
    throw new Error('Full queue subscription is forbidden');
  },
  useQueueActions: () => queueActions,
  useQueueSessionId: () => {
    useMetadataRevision();
    return { sessionId: metadata.sessionId };
  },
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
import { useSubmitMobileAppFeedback } from '../../../lib/feedback/use-submit-app-feedback';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const closeRequested = vi.fn();
function Host({ initialVisible = false }: { initialVisible?: boolean }) {
  const [visible, setVisible] = useState(initialVisible);
  const sheetRef = createRef<ManagedSheetHandle>();
  return (
    <>
      <button onClick={() => setVisible(true)}>Open feedback</button>
      <FeedbackSheet
        sheetRef={sheetRef}
        mode="bug"
        visible={visible}
        onClose={() => {
          closeRequested();
          setVisible(false);
        }}
      />
    </>
  );
}
function mountFeedback(initialVisible = false) {
  const onRender = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <Profiler id="feedback" onRender={onRender}>
        <Host initialVisible={initialVisible} />
      </Profiler>
    </QueryClientProvider>,
  );
  return { ...rendered, onRender };
}

beforeEach(() => {
  request.mockReset().mockResolvedValue({ submitAppFeedback: true });
  uploadFeedbackScreenshots.mockReset().mockResolvedValue(['screenshot-key']);
  closeRequested.mockClear();
  showToast.mockClear();
  metadata.pathname = '/home';
  metadata.sessionId = 'session-before';
  metadata.climbUuid = 'climb-before';
  metadata.boardName = 'kilter';
});

it('unsubscribes while closed, keeps drafts, and does not reopen after native dismissal', async () => {
  const { onRender, getByText, getByPlaceholderText, container } = mountFeedback();
  expect(metadata.subscriptions).toBe(0);
  const closedRenders = onRender.mock.calls.length;
  act(() => {
    metadata.pathname = '/discover';
    updateMetadata();
  });
  expect(onRender).toHaveBeenCalledTimes(closedRenders);
  fireEvent.click(getByText('Open feedback'));
  expect(metadata.subscriptions).toBe(3);
  fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
    target: { value: 'Keep this draft on close' },
  });
  act(() => nativeSheet.close?.());
  expect(metadata.subscriptions).toBe(0);
  expect(container.querySelector('[data-modal-sheet="false"]')).not.toBeNull();
  act(() => {
    metadata.pathname = '/climbs';
    updateMetadata();
  });
  expect(container.querySelector('[data-modal-sheet="false"]')).not.toBeNull();
  fireEvent.click(getByText('Open feedback'));
  expect((getByPlaceholderText('feedbackForm.bugPlaceholder') as HTMLInputElement).value).toBe(
    'Keep this draft on close',
  );
});

it('reads current board, route, session, and queue after a dismissed screenshot upload', async () => {
  let finishUpload: (keys: string[]) => void = () => {};
  uploadFeedbackScreenshots.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishUpload = resolve;
    }),
  );
  let finishMutation: (response: { submitAppFeedback: boolean }) => void = () => {};
  request.mockReturnValueOnce(
    new Promise<{ submitAppFeedback: boolean }>((resolve) => {
      finishMutation = resolve;
    }),
  );
  const { getByPlaceholderText, container } = mountFeedback(true);
  fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
    target: { value: 'The board disappeared during the climb' },
  });
  fireEvent.click(container.querySelector('[data-screenshot-picker]')!);
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  expect(uploadFeedbackScreenshots).toHaveBeenCalledTimes(1);
  act(() => nativeSheet.close?.());
  expect(metadata.subscriptions).toBe(3);
  act(() => {
    metadata.pathname = '/climbs';
    metadata.sessionId = 'session-after';
    metadata.climbUuid = 'climb-after';
    metadata.boardName = 'tension';
    updateMetadata();
  });
  // Queue-only change: no metadata render publishes a new reader closure.
  metadata.climbUuid = 'queue-only-latest';
  await act(async () => {
    finishUpload(['screenshot-key']);
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0][1]).toMatchObject({
    input: {
      boardName: 'tension',
      screenshotKeys: ['screenshot-key'],
      context: { url: '/climbs', sessionId: 'session-after', climbUuid: 'queue-only-latest' },
    },
  });
  expect(metadata.subscriptions).toBe(3);
  await act(async () => {
    finishMutation({ submitAppFeedback: true });
  });
  await vi.waitFor(() => expect(metadata.subscriptions).toBe(0));
  expect(container.querySelector('[data-modal-sheet="false"]')).not.toBeNull();
});

it('retains attachments and draft after an upload failure and allows retry', async () => {
  uploadFeedbackScreenshots.mockRejectedValueOnce(new Error('upload failed'));
  const { getByPlaceholderText, container } = mountFeedback(true);
  fireEvent.change(getByPlaceholderText('feedbackForm.bugPlaceholder'), {
    target: { value: 'Keep the screenshot for retry' },
  });
  fireEvent.click(container.querySelector('[data-screenshot-picker]')!);
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.uploadFailed', 'error'));
  expect(request).not.toHaveBeenCalled();
  expect(container.querySelector('[data-screenshot-picker="file:///shot-0.jpg"]')).not.toBeNull();
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
});

it('refuses submission before metadata is mounted instead of filing stale context', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useSubmitMobileAppFeedback({ current: null }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await expect(
      result.current.mutateAsync({
        source: 'drawer-bug',
        rating: null,
        comment: 'The route was unavailable',
        contactConsent: false,
        screenshotKeys: null,
      }),
    ).rejects.toThrow('Feedback metadata is not ready');
  });
  expect(request).not.toHaveBeenCalled();
});
