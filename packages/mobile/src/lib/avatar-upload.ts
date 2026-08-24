import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';

// The backend caps avatars at 2MB and accepts jpg/png/gif/webp. The picker +
// expo-image-manipulator compress to a ≤1024px JPEG before we ever get here, so
// in practice every upload is a small JPEG well under the limit.
const AVATAR_ENDPOINT = `${BACKEND_URL}/api/avatars`;

/**
 * The same cap the backend enforces (`MAX_FILE_SIZE` in
 * `packages/backend/src/handlers/avatars.ts`). Kept mobile-local rather than
 * shared: it is a property of the avatar endpoint, and duplicating one number
 * beats making every consumer of `@boardsesh/shared-schema` care about it.
 * Checking it here turns a wasted multi-megabyte upload into an instant refusal.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** A picked (and already-compressed) local image ready to upload. */
export type AvatarUploadFile = {
  /**
   * Local file URI (file://...) from the picker/manipulator. Used for the
   * on-screen preview; the upload itself goes off `bytes`.
   */
  uri: string;
  /**
   * The image bytes, already read from `uri` and proven non-empty at pick time.
   * Carrying the bytes instead of re-reading the URI here is deliberate: an
   * unusable pick reads back as an empty array without throwing anywhere in the
   * chain, so the read has to happen where we can still recover and report what
   * came back (see `compressAvatar` in EditProfileScreen).
   */
  bytes: Uint8Array;
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
 * which attaches the bearer token, refreshes it when stale, and retries once on
 * 401. We deliberately do NOT set `Content-Type` — the multipart boundary is
 * added by the fetch layer, and `authenticatedFetch` only touches `Authorization`.
 */
export async function uploadAvatar(file: AvatarUploadFile, userId: string): Promise<string> {
  // Last gate before the POST. The multipart encoder only awaits `bytes()` at
  // encode time and writes whatever it gets, empty included, so an unusable
  // image that reaches here would be stored as a zero-byte avatar behind a URL
  // we then persist forever — the picture looks saved and renders as initials.
  // Refusing costs the user a warning toast; accepting costs them their avatar.
  const avatarBytes = file.bytes;
  if (avatarBytes.length === 0 || avatarBytes.length > MAX_AVATAR_BYTES) {
    throw new Error('Avatar upload failed');
  }

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
    bytes: () => Promise.resolve(avatarBytes),
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
