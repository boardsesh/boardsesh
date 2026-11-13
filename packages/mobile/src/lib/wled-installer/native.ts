import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import {
  documentDirectory,
  cacheDirectory,
  makeDirectoryAsync,
  writeAsStringAsync,
  readAsStringAsync,
  getInfoAsync,
  deleteAsync,
  createUploadTask,
  FileSystemUploadType,
  FileSystemSessionType,
} from './legacy';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { shareAsync } from 'expo-sharing';
import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import { WledInstallerError, isObject, readManifest, type InstallerIO, type InstallJournal } from './engine';

const AWAKE_TAG = 'boardsesh-wled-install';
const activeUploads = new Set<string>();
function ensureNative() {
  if (Platform.OS === 'web' || !documentDirectory || !cacheDirectory) throw new WledInstallerError('unavailable');
}
async function ensureDirectory(): Promise<string> {
  ensureNative();
  const directory = `${documentDirectory}wled-backups/`;
  await makeDirectoryAsync(directory, { intermediates: true });
  return directory;
}
async function urlKey(url: string): Promise<string> {
  return [...new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(url)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function request<Result>(
  url: string,
  signal: AbortSignal,
  read: (response: Response) => Promise<Result>,
  timeoutMs = 8000,
  allowAssetRedirects = false,
): Promise<Result> {
  const abortController = new AbortController();
  const cancel = () => abortController.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) abortController.abort();
  const timeout = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      credentials: 'omit',
      redirect: allowAssetRedirects ? 'follow' : 'error',
      headers: { Accept: allowAssetRedirects ? 'application/octet-stream' : 'application/json' },
    });
    if (response.status === 401 || response.status === 403) throw new WledInstallerError('locked');
    if (!response.ok) throw new WledInstallerError('unavailable');
    return await read(response);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
function requireHttpsAssetUrl(url: string): void {
  let assetUrl: URL;
  try {
    assetUrl = new URL(url);
  } catch {
    throw new WledInstallerError('incompatible');
  }
  if (assetUrl.protocol !== 'https:' || assetUrl.username || assetUrl.password)
    throw new WledInstallerError('incompatible');
}
export const nativeInstallerIO: InstallerIO = {
  async readJson(url, signal) {
    return request(url, signal, (response) => response.json());
  },
  async checkUpdateAccess(url, signal) {
    // WLED returns the update form only after checking its PIN and OTA locks.
    const form = await request(`${normalizeLocalControllerUrl(url)}/update`, signal, (response) => response.text());
    if (!form.includes('/update') || !form.includes('multipart/form-data')) throw new WledInstallerError('locked');
  },
  async saveBackup(identity, config, presets) {
    const directory = await ensureDirectory();
    const uri = `${directory}${identity.controllerId}-${Date.now()}.json`;
    await writeAsStringAsync(uri, JSON.stringify({ backupVersion: 1, identity, config, presets }));
    return uri;
  },
  async exportBackup(uri) {
    ensureNative();
    await shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json' });
  },
  async download(release, signal) {
    ensureNative();
    requireHttpsAssetUrl(release.url);
    const bytes = await request(
      release.url,
      signal,
      async (response) => {
        // Native fetch follows GitHub's release-asset redirect. Validate the final URL
        // before reading bytes; controller requests retain redirect:error above.
        requireHttpsAssetUrl(response.url);
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null && Number(declaredLength) !== release.imageBytes)
          throw new WledInstallerError('imageSize');
        return response.arrayBuffer();
      },
      30_000,
      true,
    );
    if (bytes.byteLength !== release.imageBytes) throw new WledInstallerError('imageSize');
    const checksum = [...new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (checksum !== release.sha256) throw new WledInstallerError('checksum');
    if (signal.aborted) throw new WledInstallerError('cancelled');
    const uri = `${cacheDirectory}boardsesh-wled-${release.sha256}.bin`;
    await new File(uri).write(new Uint8Array(bytes));
    return { uri, bytes: bytes.byteLength, sha256: checksum };
  },
  async upload(url, uri, signal, progress) {
    ensureNative();
    if (signal.aborted) throw new WledInstallerError('cancelled');
    const target = normalizeLocalControllerUrl(url);
    if (activeUploads.has(target)) throw new WledInstallerError('unavailable');
    const task = createUploadTask(
      `${target}/update`,
      uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystemUploadType.MULTIPART,
        fieldName: 'update',
        mimeType: 'application/octet-stream',
        sessionType: FileSystemSessionType.FOREGROUND,
        headers: { Accept: 'text/html' },
      },
      ({ totalBytesSent, totalBytesExpectedToSend }) =>
        progress(totalBytesExpectedToSend > 0 ? Math.min(1, totalBytesSent / totalBytesExpectedToSend) : null),
    );
    let rejectInterruption: ((error: WledInstallerError) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const cancel = () => {
      void task.cancelAsync().catch(() => undefined);
      rejectInterruption?.(new WledInstallerError('cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => {
      void task.cancelAsync().catch(() => undefined);
      rejectInterruption?.(new WledInstallerError('unavailable'));
    }, 120_000);
    try {
      activeUploads.add(target);
      const nativeCompletion = task.uploadAsync();
      void nativeCompletion.finally(() => activeUploads.delete(target)).catch(() => undefined);
      const result = await Promise.race([nativeCompletion, interrupted]);
      if (result?.status === 401 || result?.status === 403) throw new WledInstallerError('locked');
      if (!result || result.status !== 200) throw new WledInstallerError('unavailable');
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancel);
    }
  },
  async readJournal(url) {
    const uri = `${await ensureDirectory()}pending-${await urlKey(url)}.json`;
    if (!(await getInfoAsync(uri)).exists) return null;
    const parsed: unknown = JSON.parse(await readAsStringAsync(uri));
    if (
      !isObject(parsed) ||
      parsed.url !== url ||
      !isObject(parsed.before) ||
      !isObject(parsed.backup) ||
      typeof parsed.backup.uri !== 'string' ||
      !isObject(parsed.backup.config) ||
      !isObject(parsed.backup.presets) ||
      typeof parsed.before.controllerId !== 'string' ||
      !/^wled-[a-f0-9]{12}$/.test(parsed.before.controllerId)
    ) {
      throw new WledInstallerError('verification');
    }
    const [release] = readManifest({ manifestVersion: 1, releases: [parsed.release] });
    return { ...parsed, release } as InstallJournal;
  },
  async writeJournal(journal) {
    await writeAsStringAsync(
      `${await ensureDirectory()}pending-${await urlKey(journal.url)}.json`,
      JSON.stringify(journal),
    );
  },
  async clearJournal(url) {
    await deleteAsync(`${await ensureDirectory()}pending-${await urlKey(url)}.json`, { idempotent: true });
  },
  async awake(enabled) {
    if (enabled) await activateKeepAwakeAsync(AWAKE_TAG);
    else await deactivateKeepAwake(AWAKE_TAG);
  },
  wait(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        reject(new WledInstallerError('cancelled'));
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, milliseconds);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  },
};
