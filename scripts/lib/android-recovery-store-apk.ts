/// <reference types="node" />

const APPLICATION_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app';
const MAX_APK_BYTES = 256 * 1024 * 1024;

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid generated Play APK metadata.');
  return input as Record<string, unknown>;
}

/** A universal APK or the main base split contains the embedded Expo manifest. */
export function selectGeneratedApkDownload(input: unknown): string {
  const groups = record(input).generatedApks;
  if (!Array.isArray(groups)) throw new Error('Missing generated Play APKs.');
  for (const group of groups.map(record)) {
    const candidates: unknown[] = group.generatedUniversalApk ? [group.generatedUniversalApk] : [];
    if (group.generatedSplitApks !== undefined) {
      if (!Array.isArray(group.generatedSplitApks)) throw new Error('Invalid generated Play APK splits.');
      candidates.push(
        ...group.generatedSplitApks
          .map(record)
          .filter((split) => split.moduleName === 'base' && (split.splitId === '' || split.splitId === undefined)),
      );
    }
    for (const candidate of candidates.map(record)) {
      if (typeof candidate.downloadId === 'string' && candidate.downloadId.trim()) return candidate.downloadId;
    }
  }
  throw new Error('No generated Play APK contains the base module.');
}

/** GET-only provenance for an upload whose response was lost; never creates a Play edit. */
export async function readGeneratedPlayApk(
  accessToken: string,
  versionCode: string,
  { fetchImpl = fetch, maxBytes = MAX_APK_BYTES }: { fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<Uint8Array> {
  if (!/^[1-9]\d*$/.test(versionCode) || !Number.isSafeInteger(Number(versionCode)))
    throw new Error('Invalid generated Play APK versionCode.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_APK_BYTES)
    throw new Error('Invalid generated Play APK size bound.');
  const request = async (path: string) => {
    let response: Response;
    try {
      response = await fetchImpl(`${APPLICATION_URL}/generatedApks/${versionCode}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error('Generated Play APK request failed.');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Generated Play APK request returned HTTP ${response.status}.`);
    }
    return response;
  };
  const metadata = await request('');
  let parsed: unknown;
  try {
    parsed = await metadata.json();
  } catch {
    throw new Error('Invalid generated Play APK metadata.');
  }
  const downloadId = selectGeneratedApkDownload(parsed);
  const response = await request(`/downloads/${encodeURIComponent(downloadId)}:download?alt=media`);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Generated Play APK exceeds its size bound.');
  }
  if (!response.body) throw new Error('Generated Play APK has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error('Generated Play APK body read failed.');
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new Error('Generated Play APK exceeds its size bound.');
      chunks.push(chunk.value);
    }
    if (length === 0) throw new Error('Generated Play APK is empty.');
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
