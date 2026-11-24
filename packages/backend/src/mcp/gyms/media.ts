import { fetchPublicHttpsResource } from '../../auth/partner/secure-resource-fetch';
import { GraphQLError } from 'graphql';
import { GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { detectImageMimeType } from '../../lib/image-mime';
import { readBodyWithCap } from '../../lib/safe-image-fetch';
import { reencodeUploadedImage } from '../../lib/image-resize';
import { storeVersionedGymImage, removeVersionedGymImage, type GymImageKind } from '../../services/gym-image-storage';
import { resolveGymForTool } from './domain';
import type { GymMcpPrincipal } from './auth';

let activeImagePreparations = 0;
const activeImageConnections = new Set<string>();
let outstandingImageFetches = 0;
const MAX_OUTSTANDING_IMAGE_FETCHES = 4;

export interface PreparedGymImage {
  storedUrl: string;
  discard(): Promise<void>;
}

function invalidImage(message: string): never {
  throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

function cancelledImage(): GraphQLError {
  return new GraphQLError('The image upload was cancelled.', { extensions: { code: 'CANCELLED' } });
}

function checkImageCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledImage();
}

/** Validate before locking the OAuth grant; DNS pinning prevents a second lookup from reaching a private host. */
export async function fetchGymMcpImage(
  imageUrl: string,
  kind: GymImageKind,
  fetchResource: typeof fetchPublicHttpsResource = fetchPublicHttpsResource,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  checkImageCancellation(signal);
  const parsed = URL.canParse(imageUrl) ? new URL(imageUrl) : null;
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    invalidImage('Use a public HTTPS image URL without credentials, a custom port, or a fragment.');
  }
  const maximumBytes = kind === 'photo' ? GYM_PHOTO_MAX_UPLOAD_BYTES : 2 * 1024 * 1024;
  if (outstandingImageFetches >= MAX_OUTSTANDING_IMAGE_FETCHES) {
    throw new GraphQLError('Image fetching is busy. Try again shortly.', {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 2 },
    });
  }
  let response: Response;
  const controller = new AbortController();
  let cancelRequest: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancelRequest = () => {
      controller.abort();
      reject(cancelledImage());
    };
    signal?.addEventListener('abort', cancelRequest, { once: true });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Image fetch timed out'));
    }, 10_000);
    timeout.unref();
  });
  let bytes: Buffer | null;
  let mimeType: string;
  try {
    // A timed-out dns.lookup cannot be cancelled. Keep its slot until the
    // actual transport settles, so repeated deadlines cannot grow that work.
    outstandingImageFetches += 1;
    const fetchJob = Promise.resolve()
      .then(() =>
        fetchResource(imageUrl, {
          signal: controller.signal,
          headers: { Accept: 'image/jpeg, image/png, image/gif, image/webp' },
          redirect: 'error',
        }),
      )
      .finally(() => {
        outstandingImageFetches -= 1;
      });
    response = await Promise.race([fetchJob, deadline, cancellation]);
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel();
      invalidImage('The image URL must return the image directly, without a redirect or sign-in.');
    }
    mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (
      !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType) ||
      Number(response.headers.get('content-length')) > maximumBytes
    ) {
      await response.body?.cancel();
      invalidImage(`Use a JPG, PNG, GIF, or WebP image smaller than ${maximumBytes / 1024 / 1024} MB.`);
    }
    bytes = await Promise.race([readBodyWithCap(response, maximumBytes), deadline, cancellation]);
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    invalidImage(
      'That image could not be fetched. Use a publicly accessible HTTPS image or upload it on the gym page.',
    );
  } finally {
    clearTimeout(timeout);
    if (cancelRequest) signal?.removeEventListener('abort', cancelRequest);
    controller.abort();
  }
  if (!bytes?.length || detectImageMimeType(bytes) !== mimeType)
    invalidImage('The image contents do not match a supported image type or exceed the size limit.');
  checkImageCancellation(signal);
  let encoded: Buffer;
  try {
    encoded = await reencodeUploadedImage(bytes, mimeType);
  } catch {
    invalidImage('The image could not be decoded safely. Try another image.');
  }
  checkImageCancellation(signal);
  if (encoded.length > maximumBytes) invalidImage('The decoded image is too large. Resize it and try again.');
  return { bytes: encoded, mimeType };
}

export async function prepareGymMcpImage(
  principal: GymMcpPrincipal,
  gymUuid: string,
  kind: GymImageKind,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<PreparedGymImage> {
  if (!principal.scopes.includes('gyms:write'))
    throw new GraphQLError('Allow gym changes before uploading an image.', { extensions: { code: 'FORBIDDEN' } });
  checkImageCancellation(signal);
  if (activeImageConnections.has(principal.connectionId))
    throw new GraphQLError('An image upload is already in progress for this connection. Try again shortly.', {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 2 },
    });
  if (activeImagePreparations >= 2)
    throw new GraphQLError('Image uploads are busy. Try again shortly.', {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 2 },
    });
  activeImagePreparations += 1;
  activeImageConnections.add(principal.connectionId);
  try {
    const gym = await resolveGymForTool(gymUuid, principal.userId);
    checkImageCancellation(signal);
    const { bytes, mimeType } = await fetchGymMcpImage(imageUrl, kind, fetchPublicHttpsResource, signal);
    checkImageCancellation(signal);
    const storedUrl = await storeVersionedGymImage(gym.uuid, kind, bytes, mimeType);
    if (signal?.aborted) {
      await removeVersionedGymImage(gym.uuid, kind, storedUrl);
      throw cancelledImage();
    }
    return { storedUrl, discard: () => removeVersionedGymImage(gym.uuid, kind, storedUrl) };
  } finally {
    activeImagePreparations -= 1;
    activeImageConnections.delete(principal.connectionId);
  }
}
