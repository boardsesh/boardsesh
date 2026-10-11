// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { __resetFileSystem, __seedFileSystem } from '../../../test/expo-file-system-stub';
import type { FeedbackAttachment, SharedBugDraft } from '../../lib/feedback/shared-bug-draft.types';

type SharedFile = {
  path: string;
  fileName: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
};
type SharedPayload = { files?: SharedFile[]; webUrl?: string; text?: string };
const mocks = vi.hoisted(() => ({
  hasShare: false,
  intent: {} as SharedPayload,
  reset: vi.fn(),
  nextId: 0,
  compress: vi.fn(),
  dimensions: vi.fn(),
  error: null,
}));
vi.mock('expo-share-intent', () => ({
  useShareIntent: () => ({
    hasShareIntent: mocks.hasShare,
    shareIntent: mocks.intent,
    resetShareIntent: mocks.reset,
    error: mocks.error,
  }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++mocks.nextId).padStart(12, '0')}`,
}));
vi.mock('react-native', () => ({ Image: { getSize: mocks.dimensions } }));
vi.mock('../../lib/image-compression', () => ({ compressPickedImage: mocks.compress }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { ShareReceiptProvider, useShareReceipt } from '../share-receipt-provider';
import { PENDING_SHARE_LINK_KEY, SHARED_BUG_DRAFT_KEY, saveSharedBugDraft } from '../../lib/feedback/shared-bug-draft';

const OWNED = 'document/shared-bug-drafts';
const EXISTING_NAME = '00000000-0000-4000-8000-000000000101.jpg';
const PICKED_NAME = '00000000-0000-4000-8000-000000000102.jpg';
function sharedFile(filename = 'first.mov', image = false): SharedFile {
  return {
    path: `file:///incoming/${filename}`,
    fileName: filename,
    mimeType: image ? 'image/png' : 'video/quicktime',
    size: 100,
    width: null,
    height: null,
    duration: null,
  };
}
function storedAttachment(id = 'existing'): FeedbackAttachment {
  return {
    id,
    kind: 'image',
    uri: `${OWNED}/${id === 'existing' ? EXISTING_NAME : PICKED_NAME}`,
    name: `${id}.jpg`,
    mimeType: 'image/jpeg',
    size: 100,
  };
}
function storedDraft(attachments = [storedAttachment()]): SharedBugDraft {
  return {
    id: 'draft-1',
    attachments,
    comment: 'Keep this description',
    contactConsent: false,
    uploadedKeysByUri: { [attachments[0].uri]: 'feedback-screenshots/existing.jpg' },
    uploadedKeysAccountId: 'user-1',
  };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
async function mountReceipt() {
  const rendered = renderHook(() => useShareReceipt(), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(ShareReceiptProvider, { children }),
  });
  await act(async () => {});
  return rendered;
}
function receive(rendered: Awaited<ReturnType<typeof mountReceipt>>, files: SharedFile[]) {
  mocks.hasShare = true;
  mocks.intent = { files };
  rendered.rerender();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await AsyncStorage.clear();
  mocks.hasShare = false;
  mocks.intent = {};
  mocks.nextId = 0;
  mocks.error = null;
  mocks.compress.mockResolvedValue('file:///cache/compressed.jpg');
  mocks.dimensions.mockImplementation((_uri: string, success: (width: number, height: number) => void) =>
    success(1200, 1600),
  );
  __seedFileSystem({
    'file:///incoming': {
      'first.mov': { size: 100 },
      'second.mov': { size: 200 },
      'third.mov': { size: 300 },
      'fourth.mov': { size: 400 },
      'fifth.mov': { size: 500 },
      'image.png': { size: 100 },
    },
    'file:///cache': { 'compressed.jpg': { size: 80 } },
    [OWNED]: { [EXISTING_NAME]: { size: 100 }, [PICKED_NAME]: { size: 100 } },
  });
});
afterEach(() => __resetFileSystem());

it('copies and saves a durable draft before resetting the native payload', async () => {
  const saving = deferred();
  const originalSet = AsyncStorage.setItem.bind(AsyncStorage);
  const save = vi.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, serialized) => {
    await saving.promise;
    await originalSet(key, serialized);
  });
  const copy = vi.spyOn(File.prototype, 'copy');
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(copy).toHaveBeenCalledTimes(1);
  expect(new Directory(OWNED).list()).toHaveLength(1);
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(rendered.result.current.draft).toBeNull();
  await act(async () => {
    saving.resolve();
  });
  await vi.waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  const persisted = JSON.parse((await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY))!);
  expect(persisted.attachments[0].uri).toMatch(/^document\/shared-bug-drafts\//);
  expect(rendered.result.current.draft?.attachments[0].uri).toBe(persisted.attachments[0].uri);
  expect(new File('file:///incoming/first.mov').exists).toBe(true);
});

it('keeps the native payload intact and removes only staged copies after persistence fails', async () => {
  vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('Disk unavailable'));
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(rendered.result.current.notice).toBe('failed'));
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(rendered.result.current.draft).toBeNull();
  expect(new Directory(OWNED).list()).toHaveLength(0);
  expect(new File('file:///incoming/first.mov').exists).toBe(true);
  // A new payload object with the same signature retries after a failed save.
  rendered.rerender();
  mocks.intent = { files: [sharedFile()] };
  rendered.rerender();
  await vi.waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  expect(rendered.result.current.draft?.attachments).toHaveLength(1);
});

it('preserves committed files when transient native cleanup fails', async () => {
  vi.spyOn(Paths, 'cache', 'get').mockImplementation(() => {
    throw new Error('Native cache unavailable');
  });
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  const attachment = rendered.result.current.draft!.attachments[0];
  expect(new File(attachment.uri).exists).toBe(true);
  expect(await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY)).not.toBeNull();
  expect(rendered.result.current.notice).toBeNull();
});

it('preserves committed files when native reset fails', async () => {
  mocks.reset.mockImplementationOnce(() => {
    throw new Error('Native reset unavailable');
  });
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  expect(new File(rendered.result.current.draft!.attachments[0].uri).exists).toBe(true);
  expect(await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY)).not.toBeNull();
});

it('restores a draft with account-scoped upload keys and the legacy pending beta link', async () => {
  await saveSharedBugDraft(storedDraft());
  await AsyncStorage.setItem(PENDING_SHARE_LINK_KEY, 'https://www.instagram.com/reel/abc123/');
  const rendered = await mountReceipt();
  expect(rendered.result.current.draft).toMatchObject({
    id: 'draft-1',
    comment: 'Keep this description',
    contactConsent: false,
    uploadedKeysAccountId: 'user-1',
    uploadedKeysByUri: { [`${OWNED}/${EXISTING_NAME}`]: 'feedback-screenshots/existing.jpg' },
  });
  expect(rendered.result.current.pendingLink).toBe('https://www.instagram.com/reel/abc123/');
  expect(rendered.result.current.destination).toBe('beta');
});

it('does not duplicate completed native payloads', async () => {
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(rendered.result.current.draft?.attachments).toHaveLength(1));
  const copies = vi.spyOn(File.prototype, 'copy');
  receive(rendered, [sharedFile()]);
  await act(async () => {});
  expect(rendered.result.current.draft?.attachments).toHaveLength(1);
  expect(copies).not.toHaveBeenCalled();
});

it('serializes rapid receipts without clearing the newer payload while the old save is pending', async () => {
  const firstSave = deferred();
  const originalSet = AsyncStorage.setItem.bind(AsyncStorage);
  const save = vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, serialized) => {
    await firstSave.promise;
    await originalSet(key, serialized);
  });
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  receive(rendered, [sharedFile('second.mov')]);
  await act(async () => {});
  expect(save).toHaveBeenCalledTimes(1);
  expect(mocks.reset).not.toHaveBeenCalled();
  await act(async () => {
    firstSave.resolve();
  });
  await vi.waitFor(() => expect(rendered.result.current.draft?.attachments).toHaveLength(2));
  expect(rendered.result.current.draft?.attachments.map((attachment) => attachment.name)).toEqual([
    'first.mov',
    'second.mov',
  ]);
  expect(mocks.reset).toHaveBeenCalledTimes(1);
});

it('keeps the first four mixed files and leaves typed draft fields intact on another share', async () => {
  await saveSharedBugDraft(storedDraft());
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile('image.png', true), sharedFile(), sharedFile('second.mov'), sharedFile('third.mov')]);
  await vi.waitFor(() => expect(rendered.result.current.draft?.attachments).toHaveLength(4));
  expect(rendered.result.current.notice).toBe('overflow');
  expect(rendered.result.current.draft?.attachments.map((attachment) => attachment.kind)).toEqual([
    'image',
    'image',
    'video',
    'video',
  ]);
  expect(rendered.result.current.draft).toMatchObject({ comment: 'Keep this description', contactConsent: false });
});

it('preserves unseen receipts against a stale attachment edit baseline', async () => {
  await saveSharedBugDraft(storedDraft());
  const rendered = await mountReceipt();
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(rendered.result.current.draft?.attachments).toHaveLength(2));
  const receiptId = rendered.result.current.draft!.attachments[1].id;
  await act(async () => {
    await rendered.result.current.updateDraft('draft-1', {
      attachments: [storedAttachment('picked')],
      attachmentBaselineIds: ['existing'],
    });
  });
  expect(rendered.result.current.draft?.attachments.map((attachment) => attachment.id)).toEqual([receiptId, 'picked']);
  expect(new File(`${OWNED}/${EXISTING_NAME}`).exists).toBe(false);
  expect(new File(rendered.result.current.draft!.attachments[0].uri).exists).toBe(true);
});

it('atomically removes submitted files while preserving a receipt queued before completion', async () => {
  await saveSharedBugDraft(storedDraft());
  const rendered = await mountReceipt();
  const firstSave = deferred();
  const originalSet = AsyncStorage.setItem.bind(AsyncStorage);
  const save = vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, serialized) => {
    await firstSave.promise;
    await originalSet(key, serialized);
  });
  receive(rendered, [sharedFile()]);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  let completion: Promise<boolean> = Promise.resolve(true);
  act(() => {
    completion = rendered.result.current.finishDraftSubmission('draft-1', ['existing']);
  });
  await act(async () => {
    firstSave.resolve();
    expect(await completion).toBe(false);
  });
  expect(rendered.result.current.draft?.attachments.map((attachment) => attachment.name)).toEqual(['first.mov']);
  expect(rendered.result.current.draft).toMatchObject({ comment: '', contactConsent: true, uploadedKeysByUri: {} });
  expect(new File(`${OWNED}/${EXISTING_NAME}`).exists).toBe(false);
  const remainingId = rendered.result.current.draft!.attachments[0].id;
  await act(async () => {
    expect(await rendered.result.current.finishDraftSubmission('draft-1', [remainingId])).toBe(true);
  });
  expect(rendered.result.current.draft).toBeNull();
  expect(await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY)).toBeNull();
});

it('ignores late updates and completion for a different draft ID', async () => {
  await saveSharedBugDraft(storedDraft());
  const rendered = await mountReceipt();
  await act(async () => {
    await rendered.result.current.updateDraft('stale-draft', { comment: 'Overwrite?' });
    expect(await rendered.result.current.finishDraftSubmission('stale-draft', ['existing'])).toBe(true);
  });
  expect(rendered.result.current.draft?.comment).toBe('Keep this description');
  expect(new File(`${OWNED}/${EXISTING_NAME}`).exists).toBe(true);
});
