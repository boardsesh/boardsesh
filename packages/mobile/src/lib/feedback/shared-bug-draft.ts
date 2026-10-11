import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { Image } from 'react-native';
import { FEEDBACK_ATTACHMENT_MAX_COUNT, FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { compressPickedImage } from '../image-compression';
import type { FeedbackAttachment, SharedBugDraft } from './shared-bug-draft.types';

export type { FeedbackAttachment, SharedBugDraft, SharedBugDraftUpdates } from './shared-bug-draft.types';
export const SHARED_BUG_DRAFT_KEY = 'boardsesh_pending_share_bug_v1';
export const PENDING_SHARE_LINK_KEY = 'boardsesh_pending_share_link';
const SHARED_BUG_DIRECTORY = 'shared-bug-drafts';

export class SharedAttachmentError extends Error {
  constructor(public readonly reason: 'unsupported' | 'tooLarge' | 'failed') {
    super(reason);
  }
}

function draftDirectory(): Directory {
  return new Directory(Paths.document, SHARED_BUG_DIRECTORY);
}

function isOwnedAttachmentUri(uri: string): boolean {
  const directoryUri = `${draftDirectory().uri.replace(/\/$/, '')}/`;
  if (!uri.startsWith(directoryUri)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|mp4|mov|webm)$/i.test(
    uri.slice(directoryUri.length),
  );
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

export function parseSharedBugDraft(serialized: string): SharedBugDraft | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(candidate) || typeof candidate.id !== 'string' || !Array.isArray(candidate.attachments)) return null;
  const attachments: FeedbackAttachment[] = [];
  for (const attachment of candidate.attachments.slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT)) {
    if (
      !isRecord(attachment) ||
      typeof attachment.id !== 'string' ||
      (attachment.kind !== 'image' && attachment.kind !== 'video') ||
      typeof attachment.uri !== 'string' ||
      typeof attachment.name !== 'string' ||
      typeof attachment.mimeType !== 'string' ||
      typeof attachment.size !== 'number' ||
      !Number.isFinite(attachment.size) ||
      attachment.size <= 0
    )
      continue;
    attachments.push({
      id: attachment.id,
      kind: attachment.kind,
      uri: attachment.uri,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(typeof attachment.width === 'number' ? { width: attachment.width } : {}),
      ...(typeof attachment.height === 'number' ? { height: attachment.height } : {}),
      ...(typeof attachment.duration === 'number' ? { duration: attachment.duration } : {}),
    });
  }
  const uploadedKeysByUri: Record<string, string> = {};
  if (isRecord(candidate.uploadedKeysByUri)) {
    for (const attachment of attachments) {
      const uploadedKey = candidate.uploadedKeysByUri[attachment.uri];
      if (typeof uploadedKey === 'string') uploadedKeysByUri[attachment.uri] = uploadedKey;
    }
  }
  return {
    id: candidate.id,
    attachments,
    comment: typeof candidate.comment === 'string' ? candidate.comment.slice(0, 2000) : '',
    contactConsent: typeof candidate.contactConsent === 'boolean' ? candidate.contactConsent : true,
    uploadedKeysByUri,
    ...(typeof candidate.uploadedKeysAccountId === 'string'
      ? { uploadedKeysAccountId: candidate.uploadedKeysAccountId }
      : {}),
  };
}

export async function loadSharedBugDraft(): Promise<SharedBugDraft | null> {
  const serialized = await AsyncStorage.getItem(SHARED_BUG_DRAFT_KEY);
  if (!serialized) return null;
  const draft = parseSharedBugDraft(serialized);
  if (!draft) return null;
  draft.attachments = draft.attachments.filter((attachment) => {
    if (!isOwnedAttachmentUri(attachment.uri)) return false;
    try {
      return new File(attachment.uri).exists;
    } catch {
      return false;
    }
  });
  return draft;
}

export async function saveSharedBugDraft(draft: SharedBugDraft): Promise<void> {
  await AsyncStorage.setItem(SHARED_BUG_DRAFT_KEY, JSON.stringify(draft));
}

export async function removeSharedBugDraft(): Promise<void> {
  await AsyncStorage.removeItem(SHARED_BUG_DRAFT_KEY);
}

/** Copies prepared picker assets; their library/cache sources are never removed. */
export async function stageFeedbackAttachment(attachment: FeedbackAttachment): Promise<FeedbackAttachment> {
  const source = new File(attachment.uri.startsWith('/') ? `file://${attachment.uri}` : attachment.uri);
  if (!source.exists || source.size === 0) throw new SharedAttachmentError('failed');
  if (attachment.kind === 'video' && source.size > FEEDBACK_RECORDING_MAX_UPLOAD_BYTES) {
    throw new SharedAttachmentError('tooLarge');
  }
  const directory = draftDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const extension =
    attachment.kind === 'image'
      ? 'jpg'
      : attachment.mimeType === 'video/quicktime'
        ? 'mov'
        : attachment.mimeType === 'video/webm'
          ? 'webm'
          : 'mp4';
  const destination = new File(directory, `${randomUUID()}.${extension}`);
  await source.copy(destination);
  return { ...attachment, uri: destination.uri, size: destination.size };
}

export async function prepareSharedAttachment(file: {
  path: string;
  fileName: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}): Promise<FeedbackAttachment> {
  const mimeType = file.mimeType?.toLowerCase() ?? '';
  const isImage = mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
  const isVideo = ['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType);
  if ((!isImage && !isVideo) || !file.path) throw new SharedAttachmentError('unsupported');
  if (isVideo && file.size !== null && file.size > FEEDBACK_RECORDING_MAX_UPLOAD_BYTES)
    throw new SharedAttachmentError('tooLarge');
  const uri = file.path.startsWith('/') ? `file://${file.path}` : file.path;
  let attachment: FeedbackAttachment = {
    id: randomUUID(),
    kind: isImage ? 'image' : 'video',
    uri,
    name: file.fileName || (isImage ? 'screenshot.jpg' : 'recording.mp4'),
    mimeType,
    size: file.size ?? 0,
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...(file.duration ? { duration: file.duration } : {}),
  };
  if (isImage) {
    const dimensions =
      file.width && file.height
        ? { width: file.width, height: file.height }
        : await new Promise<{ width: number; height: number }>((resolve, reject) =>
            Image.getSize(uri, (width, height) => resolve({ width, height }), reject),
          );
    const compressedUri = await compressPickedImage(uri, dimensions.width, dimensions.height, {
      maxDimension: 1600,
      quality: 0.8,
    });
    attachment = { ...attachment, uri: compressedUri, name: 'screenshot.jpg', mimeType: 'image/jpeg', ...dimensions };
  }
  return stageFeedbackAttachment(attachment);
}

/** Only files created in our staging directory are eligible for cleanup. */
export function releaseOwnedFeedbackAttachments(attachments: readonly FeedbackAttachment[]): void {
  for (const attachment of attachments) {
    if (!isOwnedAttachmentUri(attachment.uri)) continue;
    try {
      const file = new File(attachment.uri);
      if (file.exists) file.delete();
    } catch {
      /* Cleanup may retry on the next launch. */
    }
  }
}

/** Release extension/cache copies only after their durable draft is committed. */
export function releaseNativeShareCopies(files: readonly { path: string }[]): void {
  const containers = [Paths.cache, Paths.appleSharedContainers?.['group.com.boardsesh.app']].filter(
    (container): container is Directory => container !== undefined,
  );
  for (const sharedFile of files) {
    const uri = sharedFile.path.startsWith('/') ? `file://${sharedFile.path}` : sharedFile.path;
    const belongsToShare = containers.some((container) => {
      const prefix = `${container.uri.replace(/\/$/, '')}/`;
      return (
        uri.startsWith(prefix) &&
        /^boardsesh-share-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,12}$/i.test(
          uri.slice(prefix.length),
        )
      );
    });
    if (!belongsToShare) continue;
    try {
      const copy = new File(uri);
      if (copy.exists) copy.delete();
    } catch {
      /* The OS may reclaim a transient source before we do. */
    }
  }
}

export function pruneSharedBugFiles(draft: SharedBugDraft | null): void {
  const directory = draftDirectory();
  if (!directory.exists) return;
  const referencedUris = new Set(draft?.attachments.map((attachment) => attachment.uri));
  for (const entry of directory.list()) {
    if (entry instanceof File && !referencedUris.has(entry.uri)) {
      try {
        entry.delete();
      } catch {
        /* A locked file can wait for next launch. */
      }
    }
  }
}
