import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import { FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { __resetFileSystem, __seedFileSystem } from '../../../../test/expo-file-system-stub';
import type { FeedbackAttachment, SharedBugDraft } from '../shared-bug-draft.types';

const mocks = vi.hoisted(() => ({ compress: vi.fn(), dimensions: vi.fn(), nextId: 0 }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++mocks.nextId).padStart(12, '0')}`,
}));
vi.mock('react-native', () => ({ Image: { getSize: mocks.dimensions } }));
vi.mock('../../image-compression', () => ({ compressPickedImage: mocks.compress }));

import {
  loadSharedBugDraft,
  parseSharedBugDraft,
  prepareSharedAttachment,
  releaseOwnedFeedbackAttachments,
  saveSharedBugDraft,
  stageFeedbackAttachment,
  SHARED_BUG_DRAFT_KEY,
} from '../shared-bug-draft';

const OWNED = 'document/shared-bug-drafts';
const IMAGE_NAME = '00000000-0000-4000-8000-000000000101.jpg';
function attachment(overrides: Partial<FeedbackAttachment> = {}): FeedbackAttachment {
  return {
    id: 'image-1',
    kind: 'image',
    uri: `${OWNED}/${IMAGE_NAME}`,
    name: 'image.jpg',
    mimeType: 'image/jpeg',
    size: 100,
    ...overrides,
  };
}
function draft(attachments: FeedbackAttachment[] = [attachment()]): SharedBugDraft {
  return {
    id: 'draft-1',
    attachments,
    comment: 'The controls froze',
    contactConsent: false,
    uploadedKeysByUri: {},
    uploadedKeysAccountId: 'user-1',
  };
}
function sharedFile(overrides: Partial<Parameters<typeof prepareSharedAttachment>[0]> = {}) {
  return {
    path: 'file:///incoming/movie.mov',
    fileName: 'movie.mov',
    mimeType: 'video/quicktime',
    size: null,
    width: null,
    height: null,
    duration: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await AsyncStorage.clear();
  mocks.nextId = 0;
  mocks.compress.mockResolvedValue('file:///cache/compressed.jpg');
  mocks.dimensions.mockImplementation((_uri: string, success: (width: number, height: number) => void) =>
    success(3000, 2000),
  );
  __seedFileSystem({
    'file:///incoming': { 'movie.mov': { size: 500 }, 'image.png': { size: 800 }, 'empty.mov': { size: 0 } },
    'file:///cache': { 'compressed.jpg': { size: 200 } },
    [OWNED]: { [IMAGE_NAME]: { size: 100 } },
  });
});
afterEach(() => __resetFileSystem());

describe('shared bug draft storage', () => {
  it('rejects malformed persisted schemas and excludes empty or unsupported descriptors', () => {
    expect(parseSharedBugDraft('invalid JSON')).toBeNull();
    expect(parseSharedBugDraft(JSON.stringify({ attachments: [] }))).toBeNull();
    const parsed = parseSharedBugDraft(
      JSON.stringify(
        draft([
          attachment({ id: 'empty', size: 0 }),
          { ...attachment(), id: 'invalid', kind: 'document' } as unknown as FeedbackAttachment,
          attachment({ id: 'valid' }),
        ]),
      ),
    );
    expect(parsed?.attachments.map((entry) => entry.id)).toEqual(['valid']);
  });

  it('caps persisted attachments, clips comments, and retains only attached URI keys and their account', () => {
    const persisted = draft(
      Array.from({ length: 6 }, (_entry, index) => attachment({ id: `image-${index}`, uri: `${OWNED}/${index}.jpg` })),
    );
    persisted.comment = 'x'.repeat(2100);
    persisted.uploadedKeysByUri = {
      [`${OWNED}/0.jpg`]: 'feedback-screenshots/zero.jpg',
      'file:///unattached.jpg': 'feedback-screenshots/stale.jpg',
    };
    const parsed = parseSharedBugDraft(JSON.stringify(persisted));
    expect(parsed?.attachments).toHaveLength(4);
    expect(parsed?.comment).toHaveLength(2000);
    expect(parsed?.uploadedKeysAccountId).toBe('user-1');
    expect(parsed?.uploadedKeysByUri).toEqual({ [`${OWNED}/0.jpg`]: 'feedback-screenshots/zero.jpg' });
  });

  it('restores content and cache metadata while excluding missing and unowned source paths', async () => {
    const persisted = draft([
      attachment(),
      attachment({ id: 'missing', uri: `${OWNED}/missing.jpg` }),
      attachment({ id: 'external', uri: 'file:///incoming/image.png' }),
    ]);
    persisted.uploadedKeysByUri = { [`${OWNED}/${IMAGE_NAME}`]: 'feedback-screenshots/image.jpg' };
    await saveSharedBugDraft(persisted);
    expect(await loadSharedBugDraft()).toMatchObject({
      comment: 'The controls froze',
      contactConsent: false,
      uploadedKeysAccountId: 'user-1',
      uploadedKeysByUri: { [`${OWNED}/${IMAGE_NAME}`]: 'feedback-screenshots/image.jpg' },
      attachments: [attachment()],
    });
    expect(await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY)).not.toBeNull();
  });

  it('compresses shared images, resolves missing dimensions, and copies bytes into durable storage', async () => {
    const prepared = await prepareSharedAttachment(
      sharedFile({ path: 'file:///incoming/image.png', mimeType: 'image/png', fileName: 'image.png' }),
    );
    expect(mocks.dimensions).toHaveBeenCalled();
    expect(mocks.compress).toHaveBeenCalledWith('file:///incoming/image.png', 3000, 2000, {
      maxDimension: 1600,
      quality: 0.8,
    });
    expect(prepared).toMatchObject({
      kind: 'image',
      uri: `${OWNED}/00000000-0000-4000-8000-000000000002.jpg`,
      mimeType: 'image/jpeg',
      name: 'screenshot.jpg',
      size: 200,
    });
    expect(new File(prepared.uri).exists).toBe(true);
    expect(new File('file:///incoming/image.png').exists).toBe(true);
  });

  it('checks actual recording bytes rather than trusting shared size metadata', async () => {
    __seedFileSystem({ 'file:///incoming': { 'movie.mov': { size: FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1 } } });
    await expect(prepareSharedAttachment(sharedFile({ size: 1 }))).rejects.toMatchObject({ reason: 'tooLarge' });
    expect(mocks.compress).not.toHaveBeenCalled();
    __seedFileSystem({ 'file:///incoming': { 'movie.mov': { size: FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } } });
    const prepared = await prepareSharedAttachment(sharedFile());
    expect(prepared.size).toBe(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES);
    expect(prepared.uri).toMatch(/\.mov$/);
  });

  it('rejects an explicitly oversized share before touching an unavailable Android source', async () => {
    await expect(
      prepareSharedAttachment(
        sharedFile({ path: 'file:///missing.mov', size: FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1 }),
      ),
    ).rejects.toMatchObject({ reason: 'tooLarge' });
  });

  it('rejects unsupported media, missing sources, and zero-byte sources', async () => {
    await expect(prepareSharedAttachment(sharedFile({ mimeType: 'application/pdf' }))).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(prepareSharedAttachment(sharedFile({ path: 'file:///incoming/missing.mov' }))).rejects.toMatchObject({
      reason: 'failed',
    });
    await expect(prepareSharedAttachment(sharedFile({ path: 'file:///incoming/empty.mov' }))).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it('gives duplicate filenames unique durable copies and only deletes app-owned files', async () => {
    const first = await stageFeedbackAttachment(
      attachment({ uri: 'file:///incoming/movie.mov', kind: 'video', mimeType: 'video/quicktime', name: 'movie.mov' }),
    );
    const second = await stageFeedbackAttachment(
      attachment({ uri: 'file:///incoming/movie.mov', kind: 'video', mimeType: 'video/quicktime', name: 'movie.mov' }),
    );
    expect(first.uri).not.toBe(second.uri);
    releaseOwnedFeedbackAttachments([first, attachment({ uri: 'file:///incoming/movie.mov' })]);
    expect(new File(first.uri).exists).toBe(false);
    expect(new File(second.uri).exists).toBe(true);
    expect(new File('file:///incoming/movie.mov').exists).toBe(true);
  });

  it('rejects directory traversal in persisted attachment ownership and cleanup', async () => {
    const traversal = attachment({ id: 'traversal', uri: `${OWNED}/../private.jpg` });
    __seedFileSystem({ [`${OWNED}/..`]: { 'private.jpg': { size: 100 } } });
    await saveSharedBugDraft(draft([traversal]));
    expect((await loadSharedBugDraft())?.attachments).toEqual([]);
    releaseOwnedFeedbackAttachments([traversal]);
    expect(new File(traversal.uri).exists).toBe(true);
  });
});
