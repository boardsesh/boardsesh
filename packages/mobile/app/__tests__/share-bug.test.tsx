// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SharedBugDraft, SharedBugDraftUpdates } from '../../src/lib/feedback/shared-bug-draft.types';

const mocks = vi.hoisted(() => ({
  draft: null as SharedBugDraft | null,
  update: vi.fn(),
  clear: vi.fn(),
  finish: vi.fn(),
  submit: vi.fn(),
  upload: vi.fn(),
  confirm: vi.fn(),
  dismiss: vi.fn(),
  dispatch: vi.fn(),
  toast: vi.fn(),
  account: 'user-1',
  prevent: undefined as ((event: { data: { action: { type: string } } }) => void) | undefined,
}));
type ChildrenProps = { children?: ReactNode };
function wrapper({ children }: ChildrenProps) {
  return createElement('div', {}, children);
}
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: wrapper,
  ScrollView: wrapper,
  KeyboardAvoidingView: wrapper,
  TextInput: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: wrapper }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ draftId: 'draft-1' }),
  useNavigation: () => ({ dispatch: mocks.dispatch }),
  useRouter: () => ({ canDismiss: () => true, dismiss: mocks.dismiss }),
}));
vi.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (_enabled: boolean, callback: typeof mocks.prevent) => {
    mocks.prevent = callback;
  },
}));
vi.mock('../../src/components/launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: (screen: unknown) => screen,
}));
vi.mock('../../src/providers/share-receipt-provider', () => ({
  useSharedBugDraft: () => ({
    draft: mocks.draft,
    updateDraft: mocks.update,
    clearDraft: mocks.clear,
    finishDraftSubmission: mocks.finish,
  }),
  useShareReceipt: () => ({ notice: null, clearNotice: vi.fn() }),
}));
vi.mock('../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../src/providers/dialog-provider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../src/providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { background: '#fff' } }) }));
vi.mock('../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock('../../src/theme/tokens', () => ({ spacing: { 4: 16, 6: 24 } }));
vi.mock('../../src/lib/feedback/FeedbackMetadataCollector', () => ({ FeedbackMetadataCollector: () => null }));
vi.mock('../../src/lib/feedback/use-submit-app-feedback', () => ({
  useSubmitMobileAppFeedback: () => ({ mutateAsync: mocks.submit }),
}));
vi.mock('../../src/lib/feedback/attachment-upload', () => ({ uploadFeedbackAttachments: mocks.upload }));
vi.mock('../../src/lib/feedback/shared-bug-draft', () => ({
  stageFeedbackAttachment: vi.fn(),
  releaseOwnedFeedbackAttachments: vi.fn(),
}));
vi.mock('../../src/lib/local-user-id', () => ({ readLocalUserId: async () => mocks.account }));
vi.mock('../../src/lib/ble/advertisement-recon', () => ({ runBleAdvertisementRecon: vi.fn() }));
vi.mock('../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/InlineSheetError', () => ({
  InlineSheetError: ({ message }: { message: string | null }) => createElement('div', { role: 'alert' }, message),
}));
vi.mock('../../src/components/Text', () => ({ Text: wrapper }));
vi.mock('../../src/components/AccessibleTextInput', () => ({ AccessibleTextInput: () => null }));
vi.mock(
  '../../src/components/SheetTopBar',
  async () => (await import('../../src/test/sheet-top-bar-stub')).sheetTopBarModule,
);
vi.mock('../../src/components/feedback/FeedbackForm', () => ({
  BUG_COMMENT_MIN_LENGTH: 10,
  FeedbackForm: ({
    comment,
    onCommentChange,
    attachments,
    onAttachmentPickingChange,
  }: {
    comment: string;
    onCommentChange: (comment: string) => void;
    attachments: SharedBugDraft['attachments'];
    onAttachmentPickingChange: (picking: boolean) => void;
  }) =>
    createElement(
      'div',
      {},
      createElement('input', {
        'aria-label': 'description',
        value: comment,
        onChange: (event: { target: { value: string } }) => onCommentChange(event.target.value),
      }),
      createElement('span', {}, attachments.map((attachment) => attachment.name).join(',')),
      createElement('button', { onClick: () => onAttachmentPickingChange(true) }, 'Stage attachment'),
      createElement('button', { onClick: () => onAttachmentPickingChange(false) }, 'Finish staging'),
    ),
}));

import ShareBugScreen from '../share-bug';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.account = 'user-1';
  mocks.draft = {
    id: 'draft-1',
    comment: 'The controls froze',
    contactConsent: true,
    uploadedKeysByUri: {},
    attachments: [
      {
        id: 'recording-1',
        kind: 'video',
        uri: 'file:///recording.mov',
        name: 'recording.mov',
        mimeType: 'video/quicktime',
        size: 100,
      },
    ],
  };
  mocks.update.mockImplementation(async (draftId: string, updates: SharedBugDraftUpdates) => {
    if (mocks.draft?.id === draftId) mocks.draft = { ...mocks.draft, ...updates };
  });
  mocks.clear.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(true);
  mocks.confirm.mockResolvedValue(false);
  mocks.submit.mockResolvedValue(true);
  mocks.upload.mockResolvedValue({ screenshotKeys: [], recordingKeys: ['feedback-recordings/movie.mov'] });
});

it('submits shared recording keys once even with rapid repeated taps', async () => {
  const { container } = render(createElement(ShareBugScreen));
  const submit = container.querySelector('[data-button="feedbackDialog.submitBug"]')!;
  fireEvent.click(submit);
  fireEvent.click(submit);
  await vi.waitFor(() => expect(mocks.dismiss).toHaveBeenCalledTimes(1));
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'share-bug',
      recordingKeys: ['feedback-recordings/movie.mov'],
      comment: 'The controls froze',
    }),
  );
  expect(mocks.finish).toHaveBeenCalledWith('draft-1', ['recording-1']);
});

it('retains the description, files, and successful upload cache after a failed batch', async () => {
  mocks.upload.mockImplementationOnce(
    async (_attachments, _cache, remember: (uri: string, key: string) => Promise<void>) => {
      await remember('file:///recording.mov', 'feedback-recordings/movie.mov');
      throw new Error('Network interrupted');
    },
  );
  const { container, getByLabelText } = render(createElement(ShareBugScreen));
  fireEvent.change(getByLabelText('description'), { target: { value: 'Keep this report for retry' } });
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(container.textContent).toContain('feedbackAttachments.uploadFailed'));
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.draft).toMatchObject({
    comment: 'Keep this report for retry',
    uploadedKeysAccountId: 'user-1',
    uploadedKeysByUri: { 'file:///recording.mov': 'feedback-recordings/movie.mov' },
  });
  expect(mocks.clear).not.toHaveBeenCalled();
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  expect(mocks.upload.mock.calls[1][1]).toEqual({ 'file:///recording.mov': 'feedback-recordings/movie.mov' });
});

it('clears keys from a different account before retrying uploads', async () => {
  mocks.draft!.uploadedKeysAccountId = 'other-user';
  mocks.draft!.uploadedKeysByUri = { 'file:///recording.mov': 'feedback-recordings/other.mov' };
  const { container } = render(createElement(ShareBugScreen));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
  expect(mocks.upload.mock.calls[0][1]).toEqual({});
});

it('keeps a cancelled removal and clears only after confirmed discard', async () => {
  render(createElement(ShareBugScreen));
  await act(async () => {
    mocks.prevent?.({ data: { action: { type: 'GO_BACK' } } });
  });
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  await act(async () => {
    mocks.prevent?.({ data: { action: { type: 'GO_BACK' } } });
  });
  expect(mocks.clear).toHaveBeenCalledWith('draft-1');
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
});

it('blocks removal while uploading', async () => {
  let finishUpload: () => void = () => {};
  mocks.upload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUpload = () => resolve({ screenshotKeys: [], recordingKeys: [] });
      }),
  );
  const { container } = render(createElement(ShareBugScreen));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
  await act(async () => {
    mocks.prevent?.({ data: { action: { type: 'GO_BACK' } } });
  });
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await act(async () => {
    finishUpload();
  });
});

it('blocks submission and discard until picked files finish staging', async () => {
  const { container, getByText } = render(createElement(ShareBugScreen));
  fireEvent.click(getByText('Stage attachment'));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await act(async () => {
    mocks.prevent?.({ data: { action: { type: 'GO_BACK' } } });
  });
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(getByText('Finish staging'));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
});

it('retries local cleanup without filing a successful report twice', async () => {
  mocks.finish.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { container } = render(createElement(ShareBugScreen));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(container.textContent).toContain('feedbackAttachments.cleanupFailed'));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(mocks.dismiss).toHaveBeenCalledTimes(1));
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.finish).toHaveBeenCalledTimes(2);
});

it('keeps the modal open and announces success inline when a concurrent share remains', async () => {
  mocks.finish.mockResolvedValueOnce(false);
  const { container, getByLabelText } = render(createElement(ShareBugScreen));
  fireEvent.click(container.querySelector('[data-button="feedbackDialog.submitBug"]')!);
  await vi.waitFor(() => expect(container.textContent).toContain('feedbackDialog.successBug'));
  expect(mocks.dismiss).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect((getByLabelText('description') as HTMLInputElement).value).toBe('');
});
