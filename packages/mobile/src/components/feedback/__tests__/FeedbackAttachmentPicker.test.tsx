// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import type { FeedbackAttachment } from '../../../lib/feedback/shared-bug-draft.types';

type ChildrenProps = { children?: ReactNode };
function wrapper({ children }: ChildrenProps) {
  return createElement('div', {}, children);
}
const mocks = vi.hoisted(() => ({ picker: vi.fn(), fileSize: vi.fn() }));
vi.mock('react-native', () => ({
  View: wrapper,
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.picker, VideoExportPreset: { Passthrough: 0 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8 }, borderRadius: { md: 8, full: 9999 } }));
vi.mock('../../../lib/feedback/attachment-upload', () => ({
  isSupportedFeedbackRecording: (mimeType: string) => ['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType),
}));
vi.mock('../../../lib/upload-image', () => ({ getUploadFileSize: mocks.fileSize }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../Text', () => ({ Text: wrapper }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../InlineSheetError', () => ({
  InlineSheetError: ({ message }: { message: string | null }) => createElement('div', { role: 'alert' }, message),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    onPress,
    children,
    disabled,
    accessibilityLabel,
  }: {
    onPress: () => void;
    children?: ReactNode;
    disabled?: boolean;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));
import { FeedbackAttachmentPicker } from '../FeedbackAttachmentPicker';

const image = {
  uri: 'file:///image.png',
  type: 'image',
  fileName: 'image.png',
  mimeType: 'image/png',
  fileSize: 100,
  width: 200,
  height: 300,
};
const video = {
  uri: 'file:///movie.mov',
  type: 'video',
  fileName: 'movie.mov',
  mimeType: 'video/quicktime',
  fileSize: 200,
  width: 200,
  height: 300,
};
const attachment: FeedbackAttachment = {
  id: 'existing',
  kind: 'image',
  uri: 'file:///existing.jpg',
  name: 'existing.jpg',
  mimeType: 'image/jpeg',
  size: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fileSize.mockResolvedValue(100);
  mocks.picker.mockResolvedValue({ canceled: false, assets: [image, video] });
});

it('requests images and videos without camera capture and stages both in selection order', async () => {
  const onChange = vi.fn();
  const stage = vi.fn(async (picked: FeedbackAttachment) => ({ ...picked, uri: `file:///owned/${picked.name}` }));
  const { getByLabelText } = render(
    createElement(FeedbackAttachmentPicker, { attachments: [], onChange, stageAttachment: stage }),
  );
  fireEvent.click(getByLabelText('feedbackAttachments.addAria'));
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(mocks.picker).toHaveBeenCalledWith(
    expect.objectContaining({ mediaTypes: ['images', 'videos'], selectionLimit: 4, videoExportPreset: 0 }),
  );
  expect(onChange.mock.calls[0][0]).toMatchObject([
    { kind: 'image', uri: 'file:///owned/image.png' },
    { kind: 'video', uri: 'file:///owned/movie.mov' },
  ]);
});

it('keeps valid images when an oversized recording is skipped and reports the limit inline', async () => {
  mocks.picker.mockResolvedValue({
    canceled: false,
    assets: [{ ...video, fileSize: FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1 }, image],
  });
  const onChange = vi.fn();
  const { getByLabelText, container } = render(createElement(FeedbackAttachmentPicker, { attachments: [], onChange }));
  fireEvent.click(getByLabelText('feedbackAttachments.addAria'));
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(onChange.mock.calls[0][0]).toHaveLength(1);
  expect(container.textContent).toContain('feedbackAttachments.tooLarge');
});

it('preserves new receipts arriving while the system picker is open and enforces four files', async () => {
  let finishPicker: (result: unknown) => void = () => {};
  mocks.picker.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPicker = resolve;
      }),
  );
  const onChange = vi.fn();
  const { getByLabelText, rerender, container } = render(
    createElement(FeedbackAttachmentPicker, { attachments: [attachment], onChange }),
  );
  fireEvent.click(getByLabelText('feedbackAttachments.addAria'));
  const existing = [
    attachment,
    { ...attachment, id: 'second', uri: 'file:///second.jpg' },
    { ...attachment, id: 'third', uri: 'file:///third.jpg' },
  ];
  rerender(createElement(FeedbackAttachmentPicker, { attachments: existing, onChange }));
  finishPicker({ canceled: false, assets: [image, video] });
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(onChange.mock.calls[0][0]).toHaveLength(4);
  expect(onChange.mock.calls[0][0].slice(0, 3)).toEqual(existing);
  expect(container.textContent).toContain('feedbackAttachments.tooMany');
});

it('renders recordings by filename and disables removal while submitting', () => {
  const recordingAttachment: FeedbackAttachment = {
    ...attachment,
    id: 'movie',
    kind: 'video',
    name: 'movie.mov',
    mimeType: 'video/quicktime',
  };
  const onChange = vi.fn();
  const { getByLabelText, container } = render(
    createElement(FeedbackAttachmentPicker, { attachments: [recordingAttachment], onChange, disabled: true }),
  );
  expect(container.textContent).toContain('movie.mov');
  fireEvent.click(getByLabelText('feedbackAttachments.removeAria'));
  expect(onChange).not.toHaveBeenCalled();
});

it('reports picker busy until durable staging and the parent update finish', async () => {
  let finishStage: (attachment: FeedbackAttachment) => void = () => {};
  const stage = vi.fn().mockImplementationOnce(
    () =>
      new Promise<FeedbackAttachment>((resolve) => {
        finishStage = resolve;
      }),
  );
  mocks.picker.mockResolvedValue({ canceled: false, assets: [image] });
  const onPickingChange = vi.fn();
  const onChange = vi.fn();
  const { getByLabelText } = render(
    createElement(FeedbackAttachmentPicker, { attachments: [], onChange, stageAttachment: stage, onPickingChange }),
  );
  fireEvent.click(getByLabelText('feedbackAttachments.addAria'));
  await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
  expect(onPickingChange.mock.calls).toEqual([[true]]);
  finishStage({ ...attachment, uri: 'file:///owned/image.jpg' });
  await vi.waitFor(() => expect(onPickingChange.mock.calls).toEqual([[true], [false]]));
  expect(onChange).toHaveBeenCalledTimes(1);
});
