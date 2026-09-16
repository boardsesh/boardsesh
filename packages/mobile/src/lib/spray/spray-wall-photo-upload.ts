// POST a wall photo to `/api/spray-wall-photos` (epic #5346, SW-09).
//
// Two ways to send the same multipart body, and which one runs is decided by
// what the platform can actually do:
//
//  1. **`createUploadTask` (native).** The legacy `expo-file-system` upload task
//     is the only thing in the app that reports BYTES SENT. A wall photo is a
//     2048 px JPEG — two to five megabytes on a phone link — and the difference
//     between a bar that moves and a spinner that does not is the difference
//     between waiting and force-quitting.
//  2. **`authenticatedFetch` + FormData (fallback).** The Expo web build has no
//     upload task, and a native upload task can fail to start for reasons that
//     have nothing to do with the network. The fallback sends the same body the
//     avatar upload does — including `appendUploadImage`'s SDK-57 `File.bytes()`
//     workaround, which is what makes one descriptor work under both RN's fetch
//     (release) and Expo's (development) — and reports progress as `null`, which
//     the screen draws as an indeterminate bar.
//
// The fallback is never silently preferred: a failure IN the upload task (a 4xx,
// a dropped connection) is a failure, not a reason to send the photo twice. Only
// the task being unusable at all falls through.

import { Platform } from 'react-native';
import { createUploadTask, FileSystemUploadType } from 'expo-file-system/legacy';
import { appendUploadImage } from '../upload-image';
import { authenticatedFetch, ensureFreshToken } from '../auth-interceptor';
import { getAuthToken } from '../auth-store';
import { BACKEND_URL } from '../env';

const SPRAY_WALL_PHOTO_ENDPOINT = `${BACKEND_URL}/api/spray-wall-photos`;

/** What the handler answers with on success. */
export type UploadedWallPhoto = {
  photoId: string;
  /** The STORED photo's pixels, after sharp's `rotate()` and re-encode. */
  width: number;
  height: number;
  /** Whether the upload could report bytes sent, or fell back to an indeterminate bar. */
  determinate: boolean;
};

export type WallPhotoUploadOptions = {
  wallUuid: string;
  /** Local JPEG, already compressed by `compressPickedImage`. */
  uri: string;
  /** 0–1 as bytes go out, or `null` once when the platform cannot say. */
  onProgress?: (progress: number | null) => void;
};

type HandlerResponse = { success?: boolean; photoId?: string; width?: number; height?: number; error?: string };

/** The message a climber sees when the handler refuses. Its own words when it gave any. */
function readHandlerError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as HandlerResponse;
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

function readHandlerSuccess(body: string, determinate: boolean): UploadedWallPhoto {
  const parsed = JSON.parse(body) as HandlerResponse;
  if (!parsed.success || !parsed.photoId) throw new Error(parsed.error ?? 'The photo upload failed');
  // The dimensions decide the canonical frame, so a response that cannot say
  // them is not a success we can build a wall on.
  if (!(typeof parsed.width === 'number' && parsed.width > 0)) throw new Error('The photo upload failed');
  if (!(typeof parsed.height === 'number' && parsed.height > 0)) throw new Error('The photo upload failed');
  return { photoId: parsed.photoId, width: parsed.width, height: parsed.height, determinate };
}

/** Send the photo with the progress-reporting native task, or `null` when it cannot run here. */
async function uploadWithTask(options: WallPhotoUploadOptions): Promise<UploadedWallPhoto | null> {
  if (Platform.OS === 'web') return null;
  // Same refresh-then-read the interceptor does, because the task sends its own
  // request and never passes through it. A token that expires mid-upload is not
  // retried — the climber taps "Try again", which is the same cost as a silent
  // retry of a multi-megabyte body and is visible.
  await ensureFreshToken();
  const token = await getAuthToken();
  if (!token) return null;

  let task: ReturnType<typeof createUploadTask>;
  try {
    task = createUploadTask(
      SPRAY_WALL_PHOTO_ENDPOINT,
      options.uri,
      {
        uploadType: FileSystemUploadType.MULTIPART,
        fieldName: 'photo',
        mimeType: 'image/jpeg',
        parameters: { wallUuid: options.wallUuid },
        headers: { Authorization: `Bearer ${token}` },
      },
      ({ totalBytesSent, totalBytesExpectedToSend }) => {
        // -1 (or 0) is the "no Content-Length" answer; report it as
        // indeterminate rather than dividing by it.
        if (!(totalBytesExpectedToSend > 0)) {
          options.onProgress?.(null);
          return;
        }
        options.onProgress?.(Math.min(1, totalBytesSent / totalBytesExpectedToSend));
      },
    );
  } catch {
    // The module could not build a task at all (no native upload module in this
    // binary). Nothing was sent, so falling back cannot duplicate the photo.
    return null;
  }

  const result = await task.uploadAsync();
  if (!result) throw new Error('The photo upload was cancelled');
  if (result.status < 200 || result.status >= 300) {
    throw new Error(readHandlerError(result.body) ?? 'The photo upload failed');
  }
  return readHandlerSuccess(result.body, true);
}

/** Send the photo with plain multipart `fetch`. No byte progress; works everywhere. */
async function uploadWithFetch(options: WallPhotoUploadOptions): Promise<UploadedWallPhoto> {
  options.onProgress?.(null);
  const formData = new FormData();
  await appendUploadImage(formData, 'photo', { uri: options.uri, name: 'wall.jpg', type: 'image/jpeg' });
  formData.append('wallUuid', options.wallUuid);

  const response = await authenticatedFetch(SPRAY_WALL_PHOTO_ENDPOINT, { method: 'POST', body: formData });
  const body = await response.text();
  if (!response.ok) throw new Error(readHandlerError(body) ?? 'The photo upload failed');
  return readHandlerSuccess(body, false);
}

/**
 * Upload one wall photo and return the id `createSprayWallVersion` adopts.
 *
 * The object sits in the private bucket unreferenced until that mutation takes
 * it, so an upload that lands and a version that is never created costs a stray
 * object the SW-17 cleanup job sweeps — never a row anybody can see.
 */
export async function uploadSprayWallPhoto(options: WallPhotoUploadOptions): Promise<UploadedWallPhoto> {
  const viaTask = await uploadWithTask(options);
  if (viaTask) return viaTask;
  return uploadWithFetch(options);
}
