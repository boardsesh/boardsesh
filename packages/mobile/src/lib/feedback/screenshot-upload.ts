import { File } from 'expo-file-system';
import { FEEDBACK_SCREENSHOT_MAX_COUNT } from '@boardsesh/shared-schema';
import { authenticatedFetch } from '../auth-interceptor';
import { BACKEND_URL } from '../env';

// The backend caps each screenshot at FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES (5MB)
// and accepts jpg/png/gif/webp. The picker + `compressPickedImage` hand us a
// ≤1600px JPEG, so in practice every upload is well under the limit.
const SCREENSHOT_ENDPOINT = `${BACKEND_URL}/api/feedback-screenshots`;

/**
 * Deadline for one screenshot.
 *
 * `authenticatedFetch` sets no deadline of its own, and a request that never
 * settles is worse here than a failed one: the sheet's `finally` never runs, so
 * `isUploading` stays true, the submit button stays disabled, and the reporter
 * gets no error — a form that silently refuses to submit. Generous enough for a
 * few hundred KB on a bad gym connection, finite so the UI always recovers.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

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
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as { success?: boolean; key?: string };
  if (!data.key) {
    throw new Error('Screenshot upload failed');
  }
  return data.key;
}

/**
 * Keys already uploaded this session, by local file URI.
 *
 * A batch upload is all-or-nothing at the caller, but not at the server: if the
 * third of four requests fails, the other three have already landed as permanent
 * objects in a public bucket that nothing sweeps. Without this map a retry would
 * upload all four again — four more orphans, and eight of the twenty-per-window
 * budget spent to file one report. Picker URIs are unique per pick, so a hit is
 * always the same bytes.
 */
const uploadedKeysByUri = new Map<string, string>();

/**
 * Hard ceiling on that map. `clearScreenshotUploadCache` only runs on a
 * SUCCESSFUL submission, so a session of picked-then-dismissed sheets would
 * otherwise keep every key it ever minted. A few submissions' worth is all the
 * retry path can use; past that the oldest entry goes, and the worst case is
 * one extra upload rather than a wrong key.
 */
const MAX_CACHED_KEYS = FEEDBACK_SCREENSHOT_MAX_COUNT * 4;

function rememberUploadedKey(uri: string, key: string): void {
  if (uploadedKeysByUri.size >= MAX_CACHED_KEYS) {
    const oldest = uploadedKeysByUri.keys().next();
    if (!oldest.done) uploadedKeysByUri.delete(oldest.value);
  }
  uploadedKeysByUri.set(uri, key);
}

/**
 * Forget the cached keys. Called once a submission has actually been filed —
 * past that point a retry is a NEW report and must not reuse the last one's
 * objects. Bounded by this: the map only ever holds one in-flight submission.
 */
export function clearScreenshotUploadCache(): void {
  uploadedKeysByUri.clear();
}

/**
 * Upload every picked screenshot and return their keys in the order they were
 * picked — the order the thumbnails were shown in, and the order they appear in
 * the GitHub comment. One request per file, because the endpoint takes one file.
 *
 * ONE AT A TIME, deliberately. Reading a picked file goes through
 * `expo-file-system`'s `File.bytes()`, and every Expo `AsyncFunction` that does
 * not ask for its own queue runs on a single shared SERIAL dispatch queue
 * (`expo.modules.AsyncFunctionQueue`). Firing four uploads at once puts four
 * `bytes()` reads in that one queue, interleaved with whatever else is using it
 * — the board renderer is a heavy user (see #5187) — so the reads starve behind
 * unrelated native work and the requests never settle. Parallelism buys nothing
 * against a serial queue anyway. The avatar upload never hit this because it
 * only ever sends one file.
 *
 * Any failure rejects: the caller keeps the typed report and toasts rather than
 * filing a half-illustrated one, and the shots that DID land are remembered so
 * the retry only sends what is missing.
 */
export async function uploadFeedbackScreenshots(uris: readonly string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const uri of uris) {
    const cached = uploadedKeysByUri.get(uri);
    if (cached) {
      keys.push(cached);
      continue;
    }
    const key = await uploadFeedbackScreenshot(uri);
    rememberUploadedKey(uri, key);
    keys.push(key);
  }
  return keys;
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
