import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_IMAGE_SIZES } from '@boardsesh/shared-schema';
import { deleteFromS3, getMediaPublicBaseUrl, isS3Configured, uploadToS3 } from '../storage/s3';
import { MIME_TO_EXT } from '../lib/image-mime';
import { resizedVariantKey, writeImageVariants } from '../lib/image-resize';
import { logger } from '../utils/logger';
import { backendPublicUrl } from '../utils/public-urls';

export type GymImageKind = 'photo' | 'logo';
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VERSIONED_IMAGE_PATH = new RegExp(
  `^/static/(gym-photos|gym-logos)/(${UUID_PATTERN})\\.(${UUID_PATTERN})\\.(jpg|png|gif|webp)(?:\\?v=[\\w-]+)?$`,
  'i',
);
const LEGACY_IMAGE_PATH = new RegExp(
  `^/static/(gym-photos|gym-logos)/(${UUID_PATTERN})\\.(jpg|jpeg|png|gif|webp)(?:\\?v=[\\w-]+)?$`,
  'i',
);
const RESIZED_IMAGE_SUFFIX = new RegExp(`@(?:${ALLOWED_IMAGE_SIZES.join('|')})\\.jpg$`);

/** Absolute display/CDN spellings still reference the same owned object family. */
function managedImagePath(storedUrl: string): string | null {
  if (storedUrl.startsWith('/static/')) return storedUrl;
  try {
    const parsed = new URL(storedUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    for (const base of ['https://api.boardsesh.com', 'https://ws.boardsesh.com', backendPublicUrl()]) {
      const backend = new URL(base);
      const prefix = backend.pathname.replace(/\/+$/, '');
      if (parsed.origin === backend.origin && parsed.pathname.startsWith(`${prefix}/static/`)) {
        return parsed.pathname.slice(prefix.length).replace(RESIZED_IMAGE_SUFFIX, '');
      }
    }
    const mediaBase = getMediaPublicBaseUrl();
    if (mediaBase) {
      const media = new URL(mediaBase);
      const prefix = `${media.pathname.replace(/\/+$/, '')}/`;
      if (parsed.origin === media.origin && parsed.pathname.startsWith(prefix)) {
        return `/static/${parsed.pathname.slice(prefix.length)}`.replace(RESIZED_IMAGE_SUFFIX, '');
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** A distinct key per upload keeps an uncommitted or refused replacement invisible. */
export async function storeVersionedGymImage(
  gymUuid: string,
  kind: GymImageKind,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  const extension = MIME_TO_EXT[mimeType];
  if (!extension || !new RegExp(`^${UUID_PATTERN}$`, 'i').test(gymUuid)) throw new Error('Invalid gym image identity');
  const prefix = kind === 'photo' ? 'gym-photos' : 'gym-logos';
  const fileName = `${gymUuid}.${randomUUID()}.${extension}`;
  const key = `${prefix}/${fileName}`;
  const storedUrl = `/static/${key}`;
  try {
    if (isS3Configured()) {
      await writeImageVariants(
        bytes,
        key,
        (variantKey, variantBytes, contentType) => uploadToS3('media', variantBytes, variantKey, contentType),
        undefined,
        mimeType,
        { rejectUndecodable: true },
      );
      await uploadToS3('media', bytes, key, mimeType);
    } else {
      await mkdir(prefix, { recursive: true });
      await writeFile(path.join(prefix, fileName), bytes, { flag: 'wx' });
    }
    return storedUrl;
  } catch (error) {
    await removeVersionedGymImage(gymUuid, kind, storedUrl);
    throw error;
  }
}

/** Only this gym's immutable uploads qualify; arbitrary URLs and legacy mutable keys never do. */
export function versionedGymImageKey(
  gymUuid: string,
  kind: GymImageKind,
  storedUrl: string | null | undefined,
): string | null {
  if (!storedUrl) return null;
  const matched = VERSIONED_IMAGE_PATH.exec(storedUrl);
  const prefix = kind === 'photo' ? 'gym-photos' : 'gym-logos';
  if (!matched || matched[1] !== prefix || matched[2]?.toLowerCase() !== gymUuid.toLowerCase()) return null;
  return storedUrl.slice('/static/'.length).split('?')[0]!;
}

/** Resolve owned uploads to their object identity; cache versions never change the stored object. */
export function managedGymImageKey(
  gymUuid: string,
  kind: GymImageKind,
  storedUrl: string | null | undefined,
): string | null {
  if (!storedUrl) return null;
  const storedPath = managedImagePath(storedUrl);
  if (!storedPath) return null;
  const versionedKey = versionedGymImageKey(gymUuid, kind, storedPath);
  if (versionedKey) return versionedKey;
  const legacyMatch = LEGACY_IMAGE_PATH.exec(storedPath);
  const prefix = kind === 'photo' ? 'gym-photos' : 'gym-logos';
  return legacyMatch && legacyMatch[1] === prefix && legacyMatch[2]?.toLowerCase() === gymUuid.toLowerCase()
    ? storedPath.slice('/static/'.length).split('?')[0]!
    : null;
}

export async function removeVersionedGymImage(
  gymUuid: string,
  kind: GymImageKind,
  storedUrl: string | null | undefined,
): Promise<void> {
  const key = versionedGymImageKey(gymUuid, kind, storedUrl);
  if (!key) return;
  await removeGymImageKey(key);
}

/** Clear this gym's previous upload, including files written by the web uploader. */
export async function removeManagedGymImage(
  gymUuid: string,
  kind: GymImageKind,
  storedUrl: string | null | undefined,
): Promise<void> {
  const key = managedGymImageKey(gymUuid, kind, storedUrl);
  if (key) await removeGymImageKey(key);
}

async function removeGymImageKey(key: string): Promise<void> {
  try {
    if (isS3Configured()) {
      await Promise.all(
        [key, ...ALLOWED_IMAGE_SIZES.map((size) => resizedVariantKey(key, size))].map((objectKey) =>
          deleteFromS3('media', objectKey),
        ),
      );
    } else {
      await unlink(key).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }
  } catch (error) {
    logger.warn('Gym image cleanup could not finish', { errorName: error instanceof Error ? error.name : 'unknown' });
  }
}
