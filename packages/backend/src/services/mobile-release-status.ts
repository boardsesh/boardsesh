import type { ReleaseContext, ReleaseContextInput } from '@boardsesh/shared-schema';

const CACHE_MS = 60_000;
const TIMEOUT_MS = 2_000;
const MAX_CACHE_ENTRIES = 500;

type RolloutSnapshot = {
  canaryUpdateId: string | null;
  checkedAt: string | null;
  known: boolean;
};
type CachedSnapshot = { expiresAt: number; promise: Promise<RolloutSnapshot> };
const rolloutCache = new Map<string, CachedSnapshot>();
const UNKNOWN: RolloutSnapshot = { canaryUpdateId: null, checkedAt: null, known: false };

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid OTA response');
  return input as Record<string, unknown>;
}

function readConfig() {
  const { OTA_STATUS_URL, OTA_STATUS_APP_ID, OTA_STATUS_EMAIL, OTA_STATUS_PASSWORD } = process.env;
  if (!OTA_STATUS_URL || !OTA_STATUS_APP_ID || !OTA_STATUS_EMAIL || !OTA_STATUS_PASSWORD) return null;
  try {
    const parsed = new URL(OTA_STATUS_URL);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return {
      baseUrl: OTA_STATUS_URL.replace(/\/manifest\/?$/, '').replace(/\/+$/, ''),
      appId: OTA_STATUS_APP_ID,
      email: OTA_STATUS_EMAIL,
      password: OTA_STATUS_PASSWORD,
    };
  } catch {
    return null;
  }
}

/** Read-only dashboard viewer API; the publishing token cannot read a rollout. */
async function readSnapshot(
  config: NonNullable<ReturnType<typeof readConfig>>,
  runtimeVersion: string,
  platform: 'ios' | 'android',
): Promise<RolloutSnapshot> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RolloutSnapshot>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(UNKNOWN);
    }, TIMEOUT_MS);
  });
  const read = async (): Promise<RolloutSnapshot> => {
    const login = await fetch(`${config.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: config.email, password: config.password }).toString(),
      signal: controller.signal,
    });
    if (!login.ok) return UNKNOWN;
    const session = record(await login.json());
    if (typeof session.token !== 'string' || !session.token) return UNKNOWN;
    const headers = { authorization: `Bearer ${session.token}` };
    const scope =
      `${config.baseUrl}/api/apps/${encodeURIComponent(config.appId)}/branch/production/` +
      `runtimeVersion/${encodeURIComponent(runtimeVersion)}`;
    const response = await fetch(`${scope}/rollout`, { headers, signal: controller.signal });
    if (!response.ok) return UNKNOWN;
    const rollout = record(await response.json());
    if (typeof rollout.active !== 'boolean') return UNKNOWN;
    if (!rollout.active) {
      return { known: true, canaryUpdateId: null, checkedAt: new Date().toISOString() };
    }
    if (!Array.isArray(rollout.updates)) return UNKNOWN;
    const updates = rollout.updates.map(record).filter((update) => update.platform === platform);
    if (updates.length === 0) {
      return { known: true, canaryUpdateId: null, checkedAt: new Date().toISOString() };
    }
    if (updates.length !== 1) return UNKNOWN;
    const update = updates[0]!;
    if (
      typeof update.percentage !== 'number' ||
      !Number.isInteger(update.percentage) ||
      update.percentage < 1 ||
      update.percentage > 99 ||
      !(
        (typeof update.updateId === 'string' && /^[1-9]\d*$/.test(update.updateId)) ||
        (typeof update.updateId === 'number' && Number.isSafeInteger(update.updateId) && update.updateId > 0)
      )
    ) {
      return UNKNOWN;
    }
    const detailsResponse = await fetch(`${scope}/updates/${encodeURIComponent(String(update.updateId))}`, {
      headers,
      signal: controller.signal,
    });
    if (!detailsResponse.ok) return UNKNOWN;
    const details = record(await detailsResponse.json());
    if (
      details.platform !== platform ||
      typeof details.updateUUID !== 'string' ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(details.updateUUID) ||
      (details.updateId != null && String(details.updateId) !== String(update.updateId))
    ) {
      return UNKNOWN;
    }
    return { known: true, canaryUpdateId: details.updateUUID, checkedAt: new Date().toISOString() };
  };
  try {
    // A deadline also bounds a stalled response body, beyond fetch's signal.
    return await Promise.race([read().catch(() => UNKNOWN), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cachedSnapshot(runtimeVersion: string, platform: 'ios' | 'android'): Promise<RolloutSnapshot> {
  const config = readConfig();
  if (!config) return UNKNOWN;
  const cacheKey = JSON.stringify([config.baseUrl, config.appId, runtimeVersion, platform]);
  const cached = rolloutCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (rolloutCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = rolloutCache.keys().next().value;
    if (oldestKey !== undefined) rolloutCache.delete(oldestKey);
  }
  const promise = readSnapshot(config, runtimeVersion, platform);
  rolloutCache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, promise });
  return promise;
}

/** Failures leave the running identity intact and canary membership unknown. */
export async function enrichReleaseContext(
  input: ReleaseContextInput | null | undefined,
  platform: string | null | undefined,
): Promise<ReleaseContext | null> {
  if (!input) return null;
  const context: ReleaseContext = {
    channel: input.channel ?? null,
    branch: input.branch ?? null,
    updateId: input.updateId ?? null,
    runtimeVersion: input.runtimeVersion ?? null,
    isEmbeddedLaunch: input.isEmbeddedLaunch ?? null,
    automaticCanary: null,
    canaryCheckedAt: null,
  };
  if (platform === 'web' || context.isEmbeddedLaunch === true || (context.branch && context.branch !== 'production')) {
    return { ...context, automaticCanary: false };
  }
  if (
    (platform !== 'ios' && platform !== 'android') ||
    context.channel !== 'production' ||
    context.isEmbeddedLaunch !== false ||
    !context.updateId ||
    !context.runtimeVersion
  ) {
    return context;
  }
  const snapshot = await cachedSnapshot(context.runtimeVersion, platform);
  return {
    ...context,
    automaticCanary: snapshot.known ? snapshot.canaryUpdateId?.toLowerCase() === context.updateId.toLowerCase() : null,
    canaryCheckedAt: snapshot.checkedAt,
  };
}

export function resetMobileReleaseStatusCacheForTests(): void {
  rolloutCache.clear();
}
