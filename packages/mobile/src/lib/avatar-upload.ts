import { File } from 'expo-file-system';
import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';

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
 * so the backend can proxy/resize it. Persisted profiles store the absolute URL,
 * matching the web client (settings-page-content.tsx). Third-party absolute URLs
 * pass through untouched.
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
 * which attaches the bearer token, refreshes it when stale, and retries once on
 * 401. We deliberately do NOT set `Content-Type` — the multipart boundary is
 * added by the fetch layer, and `authenticatedFetch` only touches `Authorization`.
 */
export async function uploadAvatar(file: AvatarUploadFile, userId: string): Promise<string> {
  const localFile = new File(file.uri);

  const formData = new FormData();
  // Expo's global `fetch` (WinterCG) rejects React Native's legacy
  // `{ uri, name, type }` FormData file descriptor with "Unsupported FormDataPart
  // implementation": its multipart encoder only accepts a string, a Blob, or an
  // object exposing `bytes()`. Hand it the file's bytes plus an explicit
  // name/type so the part carries a `filename` (busboy treats it as a file, not a
  // field) and the correct `Content-Type`. Cast through `unknown` because the DOM
  // `FormData` types only know `Blob`.
  const avatarPart = {
    name: file.name ?? 'avatar.jpg',
    type: file.type ?? 'image/jpeg',
    bytes: () => localFile.bytes(),
  };
  formData.append('avatar', avatarPart as unknown as Blob);
  formData.append('userId', userId);

  const response = await authenticatedFetch(AVATAR_ENDPOINT, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as { success?: boolean; avatarUrl?: string };
  if (!data.avatarUrl) {
    throw new Error('Avatar upload failed');
  }
  return withCacheBuster(absolutizeAvatarUrl(data.avatarUrl));
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
