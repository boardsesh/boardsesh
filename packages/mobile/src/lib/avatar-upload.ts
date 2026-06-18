import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';

// The backend caps avatars at 2MB and accepts jpg/png/gif/webp. The picker +
// expo-image-manipulator compress to a ≤1024px JPEG before we ever get here, so
// in practice every upload is a small JPEG well under the limit.
const AVATAR_ENDPOINT = backendPath('/api/avatars');

/** A picked (and already-compressed) local image ready to upload. */
export type AvatarUploadFile = {
  /** Local file URI (file://...) from the picker/manipulator. */
  uri: string;
  /** Filename sent in the multipart part; defaults to `avatar.jpg`. */
  name?: string;
  /** MIME type; defaults to `image/jpeg` (what the manipulator emits). */
  type?: string;
};

export class AvatarUploadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AvatarUploadError';
    this.status = status;
  }
}

function backendPath(path: string): string {
  return `${BACKEND_URL.replace(/\/+$/, '')}${path}`;
}

/**
 * The avatar handler returns a backend-relative URL (`/static/avatars/{id}.{ext}`)
 * so the backend can proxy/resize it. Persisted profiles store the absolute URL,
 * matching the web client (settings-page-content.tsx). Third-party absolute URLs
 * pass through untouched.
 */
export function absolutizeAvatarUrl(url: string): string {
  return url.startsWith('/') ? backendPath(url) : url;
}

/**
 * Upload an avatar image to the backend REST endpoint and return its absolute
 * URL (ready to hand to `updateProfile`). Reuses `authenticatedFetch`, which
 * attaches the bearer token, refreshes it when stale, and retries once on 401.
 * We deliberately do NOT set `Content-Type` — React Native fills in the
 * multipart boundary for a `FormData` body, and `authenticatedFetch` only ever
 * touches the `Authorization` header.
 */
export async function uploadAvatar(file: AvatarUploadFile, userId: string): Promise<string> {
  const formData = new FormData();
  // React Native's FormData accepts a `{ uri, name, type }` file descriptor at
  // runtime; the DOM lib types only know `Blob`, so cast through `unknown`.
  formData.append('avatar', {
    uri: file.uri,
    name: file.name ?? 'avatar.jpg',
    type: file.type ?? 'image/jpeg',
  } as unknown as Blob);
  formData.append('userId', userId);

  const response = await authenticatedFetch(AVATAR_ENDPOINT, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new AvatarUploadError(await readErrorMessage(response), response.status);
  }

  const data = (await response.json()) as { success?: boolean; avatarUrl?: string };
  if (!data.avatarUrl) {
    throw new Error('Avatar upload failed');
  }
  return absolutizeAvatarUrl(data.avatarUrl);
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
