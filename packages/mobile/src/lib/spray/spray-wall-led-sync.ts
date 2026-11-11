import {
  GET_SPRAY_WALL_LED_SETUP,
  SAVE_SPRAY_WALL_LED_SETUP,
  type GetSprayWallLedSetupQueryResponse,
  type SaveSprayWallLedSetupMutationResponse,
  type SaveSprayWallLedSetupMutationVariables,
  type SprayWallLedSetupData,
} from '@boardsesh/graphql/operations/spray-walls';
import { isSprayWallLedSaveRefused } from '@boardsesh/graphql/errors';
import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import { readTnutLayout, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import { getPreference, removePreference, setPreference } from '../preference-store';
import { notifySprayLedConfiguration } from './spray-led-config-events';
import {
  eraseSprayWallLedCache,
  serializeSprayWallLedCacheWrite as serializeCacheWrite,
  sprayWallLedCacheGeneration,
  notifySprayWallLedServerChange,
  notifySprayWallLedUploadOutcome,
  readSprayWallLedSettings,
  sprayWallLedLayoutKey,
  sprayWallLedSettingsKey,
  sprayWallLedUnsentKey,
  subscribeSprayWallLedCacheErased,
  type SprayWallLedField,
  type SprayWallLedSettings,
} from './spray-wall-led-cache';

/**
 * The server is the source of truth for a wall's LED setup and this phone keeps
 * a copy, so the wall still lights with no internet. Any climber who can read a
 * wall can light it; only someone who can edit the wall saves.
 *
 * Reading the setup only ever talks to the backend. A LAN request still needs a
 * climber's press (confirming an address, a test light, taking the wall).
 *
 * - A read answers from the copy when there is one and refreshes behind it, so a
 *   phone on a wall's own Wi-Fi with no internet never waits for the backend to
 *   give up. With no copy it waits for the backend.
 * - One fetch per wall: the player and DriveModeWatcher both read, and
 *   `prepareSprayWallLedRead` hands them the same request and one freshness window.
 * - Saves write the copy, then upload. One upload per wall runs at a time and it
 *   reads the newest copy when it goes, so step saves collapse and cannot land
 *   out of order. A failure stays unsent on disk and retries on the next load.
 * - `notifySprayLedConfiguration` blanks and relights the wall, so it fires from
 *   here only when the server's copy really differs from this phone's.
 */

/**
 * Loaded on demand. This module sits under the player and DriveModeWatcher, which
 * mount for every board; the HTTP client's graph only matters for a Spraywall.
 */
const httpClient = () => import('../graphql/client').then(({ getHttpClient }) => getHttpClient());
const authToken = () => import('../auth-store').then(({ getAuthToken }) => getAuthToken());

const FRESH_FOR_MS = 10 * 60 * 1000;
/** Usually a dropped connection. An older backend that lacks the query fails every time. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

type Freshness = { settledAtMs: number; freshForMs: number };
type UploadQueue = { dirty: Set<SprayWallLedField> };

const fetches = new Map<string, Promise<void>>();
const freshness = new Map<string, Freshness>();
const uploads = new Map<string, UploadQueue>();
const fieldGenerations = new Map<string, Partial<Record<SprayWallLedField, number>>>();

function fieldGenerationOf(wallUuid: string, field: SprayWallLedField): number {
  return fieldGenerations.get(wallUuid)?.[field] ?? 0;
}
/** Bumped when the copy changes for any reason but a read's answer: a read started earlier is stale. */
const writeGenerations = new Map<string, number>();
let epoch = 0;

function generationOf(wallUuid: string): number {
  return writeGenerations.get(wallUuid) ?? 0;
}

function bumpGeneration(wallUuid: string): void {
  writeGenerations.set(wallUuid, generationOf(wallUuid) + 1);
}

subscribeSprayWallLedCacheErased((wallUuid) => {
  if (wallUuid === null) {
    epoch += 1;
    fetches.clear();
    freshness.clear();
    uploads.clear();
    writeGenerations.clear();
    return;
  }
  fetches.delete(wallUuid);
  freshness.delete(wallUuid);
  uploads.delete(wallUuid);
  bumpGeneration(wallUuid);
});

/**
 * The dev story (`spray-wall-led-section--setup`) has no real wall, so its copy
 * stays on the phone and it sends nothing.
 */
function isLocalOnlyWall(wallUuid: string): boolean {
  return wallUuid.startsWith('dev-story-');
}

/** Not a local address means no address: this phone will never contact it. */
function localAddressOrEmpty(url: string): string {
  if (url === '') return '';
  try {
    return normalizeLocalControllerUrl(url);
  } catch {
    return '';
  }
}

function settingsFromServer(setup: SprayWallLedSetupData): SprayWallLedSettings {
  return {
    version: 1,
    enabled: setup.controllerType === 'wled' && setup.enabled,
    controller: { type: 'wled', url: setup.controllerType === 'wled' ? localAddressOrEmpty(setup.controllerUrl) : '' },
  };
}

function isUnsent(field: SprayWallLedField, wallUuid: string): Promise<boolean> {
  return getPreference<boolean>(sprayWallLedUnsentKey(field, wallUuid)).then(
    (stored) => stored === true,
    () => false,
  );
}

async function readCachedSettings(wallUuid: string): Promise<SprayWallLedSettings | null> {
  try {
    const stored = await getPreference<unknown>(sprayWallLedSettingsKey(wallUuid), { strictParsing: true });
    return stored === null ? null : readSprayWallLedSettings(stored);
  } catch {
    return null;
  }
}

async function readCachedLayout(wallUuid: string): Promise<TnutLayout | null> {
  try {
    const stored = await getPreference<unknown>(sprayWallLedLayoutKey(wallUuid), { strictParsing: true });
    return stored === null ? null : readTnutLayout(stored);
  } catch {
    return null;
  }
}

/** Key order is fixed by the readers, whatever order the jsonb column handed back. */
function sameLayout(left: TnutLayout | null, right: TnutLayout | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSettings(left: SprayWallLedSettings, right: SprayWallLedSettings): boolean {
  return left.enabled === right.enabled && left.controller.url === right.controller.url;
}

async function applyServerSettings(wallUuid: string, server: SprayWallLedSettings | null): Promise<boolean> {
  const cached = await readCachedSettings(wallUuid);
  const next = server ?? readSprayWallLedSettings(null);
  if (cached === null ? sameSettings(next, readSprayWallLedSettings(null)) : sameSettings(cached, next)) return false;
  await setPreference(sprayWallLedSettingsKey(wallUuid), next);
  return true;
}

async function applyServerLayout(wallUuid: string, server: TnutLayout | null): Promise<boolean> {
  const cached = await readCachedLayout(wallUuid);
  if (sameLayout(cached, server)) return false;
  if (server === null) await removePreference(sprayWallLedLayoutKey(wallUuid));
  else await setPreference(sprayWallLedLayoutKey(wallUuid), server);
  return true;
}

function publishServerChange(wallUuid: string): void {
  notifySprayLedConfiguration(wallUuid);
  notifySprayWallLedServerChange(wallUuid);
}

/**
 * The owner's first read after this feature shipped: their setup is only on this
 * phone. Upload the copy once, then the row exists and this path is closed.
 * An address the server would refuse stays behind.
 */
async function adoptLocalSetup(wallUuid: string): Promise<void> {
  const cacheGeneration = sprayWallLedCacheGeneration(wallUuid);
  const [settings, layout] = await Promise.all([readCachedSettings(wallUuid), readCachedLayout(wallUuid)]);
  const hasSettings = settings !== null && (settings.enabled || settings.controller.url !== '');
  const fields: SprayWallLedField[] = [];
  if (hasSettings) fields.push('settings');
  if (layout !== null) fields.push('layout');
  if (fields.length === 0) return;
  await Promise.all(fields.map((field) => setPreference(sprayWallLedUnsentKey(field, wallUuid), true)));
  if (sprayWallLedCacheGeneration(wallUuid) === cacheGeneration) queueUpload(wallUuid, fields);
}

async function mergeServerAnswer(
  wallUuid: string,
  answer: GetSprayWallLedSetupQueryResponse['sprayWallLedSetup'],
  startedAt: { epoch: number; generation: number },
): Promise<void> {
  const isCurrent = () => epoch === startedAt.epoch && generationOf(wallUuid) === startedAt.generation;
  if (!isCurrent()) return;

  // Null is the server's "you cannot read this wall", not a network problem.
  if (answer === null) {
    const hadCopy = (await readCachedLayout(wallUuid)) !== null || (await readCachedSettings(wallUuid)) !== null;
    if (!isCurrent()) return;
    await eraseSprayWallLedCache(wallUuid);
    if (hadCopy) publishServerChange(wallUuid);
    return;
  }

  const { setup, viewerCanEdit } = answer;
  const [settingsUnsent, layoutUnsent] = await Promise.all([
    isUnsent('settings', wallUuid),
    isUnsent('layout', wallUuid),
  ]);
  if (setup === null && viewerCanEdit) {
    if (!settingsUnsent && !layoutUnsent) await adoptLocalSetup(wallUuid);
    return;
  }

  const serverSettings = setup === null ? null : settingsFromServer(setup);
  const serverLayout = setup?.layout == null ? null : readTnutLayout(setup.layout);
  if (!isCurrent()) return;
  const settingsChanged = settingsUnsent ? false : await applyServerSettings(wallUuid, serverSettings);
  const layoutChanged = layoutUnsent ? false : await applyServerLayout(wallUuid, serverLayout);
  if (isCurrent() && (settingsChanged || layoutChanged)) publishServerChange(wallUuid);
}

function refreshFromServer(wallUuid: string): Promise<void> {
  const inFlight = fetches.get(wallUuid);
  if (inFlight) return inFlight;
  const startedAt = { epoch, generation: generationOf(wallUuid) };
  const request: Promise<void> = (async () => {
    let freshForMs = RETRY_AFTER_FAILURE_MS;
    try {
      // Reading needs an account: signed out there is nothing to ask.
      if ((await authToken()) === null) return;
      const client = await httpClient();
      const response = await client.request<GetSprayWallLedSetupQueryResponse>(GET_SPRAY_WALL_LED_SETUP, {
        boardUuid: wallUuid,
      });
      freshForMs = FRESH_FOR_MS;
      // Erasure owns its own lane; nesting it inside a write would deadlock.
      if (response.sprayWallLedSetup === null) {
        await mergeServerAnswer(wallUuid, null, startedAt);
      } else {
        await serializeCacheWrite(wallUuid, () => mergeServerAnswer(wallUuid, response.sprayWallLedSetup, startedAt));
      }
    } catch {
      // The copy stands. A storage failure reads like a dropped connection: try again later.
    }
    if (epoch === startedAt.epoch) freshness.set(wallUuid, { settledAtMs: Date.now(), freshForMs });
  })().finally(() => {
    if (fetches.get(wallUuid) === request) fetches.delete(wallUuid);
  });
  fetches.set(wallUuid, request);
  return request;
}

async function hasCachedCopy(field: SprayWallLedField, wallUuid: string): Promise<boolean> {
  const stored = await getPreference<unknown>(
    field === 'settings' ? sprayWallLedSettingsKey(wallUuid) : sprayWallLedLayoutKey(wallUuid),
  ).catch(() => null);
  return stored !== null;
}

async function retryUnsent(wallUuid: string): Promise<void> {
  const cacheGeneration = sprayWallLedCacheGeneration(wallUuid);
  if (uploads.has(wallUuid)) return;
  const [settingsUnsent, layoutUnsent] = await Promise.all([
    isUnsent('settings', wallUuid),
    isUnsent('layout', wallUuid),
  ]);
  const fields: SprayWallLedField[] = [];
  if (settingsUnsent) fields.push('settings');
  if (layoutUnsent) fields.push('layout');
  if (fields.length > 0 && sprayWallLedCacheGeneration(wallUuid) === cacheGeneration) queueUpload(wallUuid, fields);
}

/**
 * Run before reading the copy. Settles when the copy is ready to be read.
 * Never rejects: a read that needs the server and cannot reach it falls back to
 * whatever the copy has, as the setup always did.
 */
export async function prepareSprayWallLedRead(wallUuid: string, field: SprayWallLedField): Promise<void> {
  if (isLocalOnlyWall(wallUuid)) return;
  const known = freshness.get(wallUuid);
  if (known && Date.now() - known.settledAtMs < known.freshForMs) return;
  const refresh = refreshFromServer(wallUuid);
  // After the merge, which skips whatever is still unsent. Neither step can reject.
  void refresh.then(() => retryUnsent(wallUuid));
  if (await hasCachedCopy(field, wallUuid)) return;
  await refresh;
}

/**
 * The registry also withdraws a wall for routine reasons: a draft published, an
 * offline copy removed. Only the server can say access actually went, so ask it
 * rather than erasing a copy, and any unsent save, on the registry's word.
 */
export function recheckSprayWallLedAccess(wallUuid: string): void {
  if (isLocalOnlyWall(wallUuid)) return;
  freshness.delete(wallUuid);
  void refreshFromServer(wallUuid);
}

/** Call before writing the copy: from here until the server has it, a read must not replace it. */
export async function markSprayWallLedSaveStarted(
  wallUuid: string,
  field: SprayWallLedField,
  writeCopy: () => Promise<void> = async () => undefined,
): Promise<void> {
  if (isLocalOnlyWall(wallUuid)) return writeCopy();
  const cacheGeneration = sprayWallLedCacheGeneration(wallUuid);
  const assertCurrent = () => {
    if (sprayWallLedCacheGeneration(wallUuid) !== cacheGeneration) throw new Error('LED save withdrawn');
  };
  bumpGeneration(wallUuid);
  fieldGenerations.set(wallUuid, {
    ...fieldGenerations.get(wallUuid),
    [field]: fieldGenerationOf(wallUuid, field) + 1,
  });
  await serializeCacheWrite(wallUuid, async () => {
    assertCurrent();
    await setPreference(sprayWallLedUnsentKey(field, wallUuid), true);
    assertCurrent();
    await writeCopy();
    assertCurrent();
  });
  assertCurrent();
}

/** Call after the copy is written. */
export function queueSprayWallLedUpload(wallUuid: string, field: SprayWallLedField): void {
  if (isLocalOnlyWall(wallUuid)) return;
  bumpGeneration(wallUuid);
  queueUpload(wallUuid, [field]);
}

function queueUpload(wallUuid: string, fields: SprayWallLedField[]): void {
  const running = uploads.get(wallUuid);
  if (running) {
    for (const field of fields) running.dirty.add(field);
    return;
  }
  const queue: UploadQueue = { dirty: new Set(fields) };
  uploads.set(wallUuid, queue);
  void drainUploads(wallUuid, queue);
}

async function buildUploadInput(
  wallUuid: string,
  fields: SprayWallLedField[],
): Promise<SaveSprayWallLedSetupMutationVariables['input'] | null> {
  const input: SaveSprayWallLedSetupMutationVariables['input'] = { boardUuid: wallUuid };
  if (fields.includes('settings')) {
    const stored = await getPreference<unknown>(sprayWallLedSettingsKey(wallUuid), { strictParsing: true });
    const settings = readSprayWallLedSettings(stored);
    const url = localAddressOrEmpty(settings.controller.url);
    input.controllerType = settings.controller.type;
    input.controllerUrl = url;
    // Sent as stored: the switch can be on before an address exists.
    input.enabled = settings.enabled;
  }
  if (fields.includes('layout')) {
    const stored = await getPreference<unknown>(sprayWallLedLayoutKey(wallUuid), { strictParsing: true });
    const layout = stored === null ? null : readTnutLayout(stored);
    if (!layout) throw new Error('Invalid saved T-nut layout');
    input.layout = layout;
  }
  return fields.length > 0 ? input : null;
}

async function drainUploads(wallUuid: string, queue: UploadQueue): Promise<void> {
  const stale = () => uploads.get(wallUuid) !== queue;
  try {
    while (queue.dirty.size > 0 && !stale()) {
      const fields = [...queue.dirty];
      queue.dirty.clear();
      // Capture before reading disk, including saves whose copy write has not finished.
      const sentGenerations = new Map(fields.map((field) => [field, fieldGenerationOf(wallUuid, field)]));
      const clearAcknowledgedFields = () =>
        serializeCacheWrite(wallUuid, async () => {
          if (stale()) return;
          for (const field of fields) {
            if (fieldGenerationOf(wallUuid, field) === sentGenerations.get(field) && !queue.dirty.has(field)) {
              await removePreference(sprayWallLedUnsentKey(field, wallUuid));
            }
          }
        });
      try {
        const input = await serializeCacheWrite(wallUuid, () => buildUploadInput(wallUuid, fields));
        if (stale()) return;
        if (input) {
          const client = await httpClient();
          if (stale()) return;
          await client.request<SaveSprayWallLedSetupMutationResponse>(SAVE_SPRAY_WALL_LED_SETUP, { input });
        }
        if (stale()) return;
        // A read started before this upload landed still holds the old copy.
        bumpGeneration(wallUuid);
        await clearAcknowledgedFields();
        if (stale()) return;
        if (queue.dirty.size === 0) notifySprayWallLedUploadOutcome(wallUuid, 'uploaded');
      } catch (uploadError) {
        if (stale()) return;
        if (isSprayWallLedSaveRefused(uploadError)) {
          // This viewer can never send it: the server's copy wins on the next read.
          await clearAcknowledgedFields();
          if (stale()) return;
          freshness.delete(wallUuid);
        } else {
          freshness.set(wallUuid, { settledAtMs: Date.now(), freshForMs: RETRY_AFTER_FAILURE_MS });
          // A newer save came in while this one was on the wire: send them together, once.
          if (queue.dirty.size > 0) {
            for (const field of fields) queue.dirty.add(field);
            continue;
          }
        }
        notifySprayWallLedUploadOutcome(wallUuid, 'failed');
      }
    }
  } finally {
    if (uploads.get(wallUuid) === queue) uploads.delete(wallUuid);
  }
}

/** Test seam: forget this session's fetches, freshness and uploads, leaving storage alone. */
export function resetSprayWallLedSyncForTests(): void {
  epoch += 1;
  fetches.clear();
  freshness.clear();
  uploads.clear();
  writeGenerations.clear();
  fieldGenerations.clear();
}
