import { appendUploadImage } from './upload-image';
import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';
import { captureAuthenticatedResponse } from './authenticated-response-scope';
import { createAbortError } from './graphql/request-timeout';

// The backend caps avatars at 2MB and accepts jpg/png/gif/webp. The picker +
// expo-image-manipulator compress to a ≤1024px JPEG before we ever get here, so
// in practice every upload is a small JPEG well under the limit.
const AVATAR_ENDPOINT = `${BACKEND_URL}/api/avatars`;

/** A picked (and already-compressed) local image ready to upload. */
export type AvatarUploadFile = {
  /** Local file URI (file://...) from the picker/manipulator. */
  uri: string;
  /** Filename sent in the multipart part; defaults to `avatar.jpg`. */
  name?: string;
  /** MIME type; defaults to `image/jpeg` (what the manipulator emits). */
  type?: string;
};

/**
 * The avatar handler returns a backend-relative URL (`/static/avatars/{id}.{ext}`)
 * so the backend can proxy/resize it. Persisted profiles store the absolute URL.
 * Third-party absolute URLs pass through untouched.
 */
export function absolutizeAvatarUrl(url: string): string {
  return url.startsWith('/') ? `${BACKEND_URL}${url}` : url;
}

/**
 * The stored avatar filename is deterministic (`/static/avatars/{userId}.{ext}`),
 * so re-uploading returns the *same* URL — and the device image cache would keep
 * serving the previous picture. Stamp the persisted URL with the upload time so
 * the URL changes on every save, forcing every viewer (the toolbar avatar, the
 * drawer header, queue rows) to re-fetch. The backend ignores unknown query
 * params, and `sizedAvatarUri` still appends its `&size=` bucket.
 */
function withCacheBuster(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${Date.now()}`;
}

/**
 * Upload an avatar image to the backend REST endpoint and return its absolute,
 * cache-busted URL (ready to hand to `updateProfile`). Reuses `authenticatedFetch`,
 * which preserves the platform's token policy. Selected browser requests keep
 * their original lease and never replay a rejected upload. We do NOT set `Content-Type` — the multipart boundary is
 * added by the fetch layer, and `authenticatedFetch` only adds `Authorization` and
 * the `x-boardsesh-client` identity header.
 */
export async function uploadAvatar(file: AvatarUploadFile, userId: string): Promise<string> {
  const receipt = await uploadAvatarWithReceipt(file, userId);
  receipt.assertCurrent();
  return receipt.result;
}

/** The caller captures its view BEFORE picking/reading local bytes. Only the
 * actual response can supply the lease receipt for later caller-owned awaits. */
export async function uploadAvatarWithReceipt(
  file: AvatarUploadFile,
  userId: string,
  options: { readonly assertView?: () => void; readonly signal?: AbortSignal } = {},
) {
  const assertView = options.assertView;
  const signal = options.signal;
  const assertActive = () => {
    if (signal?.aborted) throw signal.reason ?? createAbortError('Avatar upload aborted');
    assertView?.();
  };
  assertActive();
  const formData = new FormData();
  await appendUploadImage(formData, 'avatar', {
    uri: file.uri,
    name: file.name ?? 'avatar.jpg',
    type: file.type ?? 'image/jpeg',
  });
  assertActive();
  formData.append('userId', userId);

  const response = await authenticatedFetch(AVATAR_ENDPOINT, {
    method: 'POST',
    body: formData,
    ...(signal ? { signal } : {}),
  });
  assertActive();
  const originalResponse = captureAuthenticatedResponse(response);
  const assertCurrent = () => {
    assertActive();
    originalResponse();
  };
  assertCurrent();

  if (!response.ok) {
    const message = await readErrorMessage(response);
    assertCurrent();
    throw new Error(message);
  }

  const data = (await response.json()) as { success?: boolean; avatarUrl?: string };
  assertCurrent();
  if (!data.avatarUrl) {
    throw new Error('Avatar upload failed');
  }
  return Object.freeze({ result: withCacheBuster(absolutizeAvatarUrl(data.avatarUrl)), assertCurrent });
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return 'Avatar upload failed';
}
