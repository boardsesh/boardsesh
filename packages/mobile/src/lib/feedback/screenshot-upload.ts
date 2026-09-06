import { File } from 'expo-file-system';
import { authenticatedFetch } from '../auth-interceptor';
import { BACKEND_URL } from '../env';

// The backend caps each screenshot at FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES (5MB)
// and accepts jpg/png/gif/webp. The picker + `compressPickedImage` hand us a
// ≤1600px JPEG, so in practice every upload is well under the limit.
const SCREENSHOT_ENDPOINT = `${BACKEND_URL}/api/feedback-screenshots`;

/**
 * Upload one picked (and already-compressed) screenshot and return the storage
 * key the feedback/verdict mutation carries. Reuses `authenticatedFetch`, which
 * attaches the bearer token, refreshes it when stale, and retries once on 401.
 * We deliberately do NOT set `Content-Type` — the multipart boundary is added by
 * the fetch layer, and `authenticatedFetch` only touches `Authorization`.
 */
export async function uploadFeedbackScreenshot(uri: string): Promise<string> {
  const localFile = new File(uri);

  const formData = new FormData();
  // Expo's global `fetch` (WinterCG) rejects React Native's legacy
  // `{ uri, name, type }` FormData file descriptor with "Unsupported FormDataPart
  // implementation": its multipart encoder only accepts a string, a Blob, or an
  // object exposing `bytes()`. Hand it the file's bytes plus an explicit
  // name/type so the part carries a `filename` (busboy treats it as a file, not a
  // field) and the correct `Content-Type`. Cast through `unknown` because the DOM
  // `FormData` types only know `Blob`.
  const screenshotPart = {
    name: 'screenshot.jpg',
    type: 'image/jpeg',
    bytes: () => localFile.bytes(),
  };
  formData.append('screenshot', screenshotPart as unknown as Blob);

  const response = await authenticatedFetch(SCREENSHOT_ENDPOINT, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as { success?: boolean; key?: string; url?: string };
  if (!data.key) {
    throw new Error('Screenshot upload failed');
  }
  return data.key;
}

/**
 * Upload every picked screenshot and return their keys in the order they were
 * picked — the order the thumbnails were shown in, and the order they appear in
 * the GitHub comment. One request per file (the endpoint takes a single file),
 * fired in parallel. Any failure rejects: the caller keeps the typed report and
 * toasts, rather than filing a half-illustrated one.
 */
export async function uploadFeedbackScreenshots(uris: readonly string[]): Promise<string[]> {
  return Promise.all(uris.map((uri) => uploadFeedbackScreenshot(uri)));
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return 'Screenshot upload failed';
}
