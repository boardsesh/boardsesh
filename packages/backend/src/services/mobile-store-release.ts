import {
  parseStoreReleaseSnapshot,
  resolveMobileStoreRelease,
  type MobileStorePlatform,
  type MobileStoreRelease,
  type StoreReleaseSnapshot,
} from '@boardsesh/shared-schema/mobile-store-release';
import { githubRequest, resolveGithubRepo, resolveGithubToken } from '../lib/github-client';
import { logger } from '../utils/logger';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const STORE_URLS: Record<MobileStorePlatform, string> = {
  ios: 'https://apps.apple.com/app/boardsesh/id6761350784',
  android: 'https://play.google.com/store/apps/details?id=com.boardsesh.app',
};

type Deployment = { id: number; payload: unknown };
type DeploymentStatus = { state: string };
type SnapshotCache = { at: number; snapshot: StoreReleaseSnapshot | null };
const snapshotCache = new Map<MobileStorePlatform, SnapshotCache>();
const inFlight = new Map<MobileStorePlatform, Promise<StoreReleaseSnapshot | null>>();

async function fetchSnapshot(platform: MobileStorePlatform, signal: AbortSignal): Promise<StoreReleaseSnapshot | null> {
  const token = await resolveGithubToken();
  signal.throwIfAborted();
  const repository = resolveGithubRepo();
  const deployments = await githubRequest<Deployment[]>(
    `/repos/${repository}/deployments?environment=mobile-public-store-${platform}&per_page=10`,
    { signal },
    token,
  );
  if (!Array.isArray(deployments)) return null;
  // GitHub returns newest first. An unfinished monitor run must not replace
  // the latest completed snapshot, but a successful withdrawal must do so.
  for (const deployment of deployments) {
    if (!Number.isSafeInteger(deployment.id) || deployment.id <= 0) return null;
    const statuses = await githubRequest<DeploymentStatus[]>(
      `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`,
      { signal },
      token,
    );
    if (!Array.isArray(statuses)) return null;
    if (statuses[0]?.state !== 'success') continue;
    let payload: unknown = deployment.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload) as unknown;
      } catch {
        return null;
      }
    }
    // Do not fall back when the newest successful payload is null or invalid.
    return parseStoreReleaseSnapshot(payload);
  }
  return null;
}

async function readSnapshot(platform: MobileStorePlatform): Promise<StoreReleaseSnapshot | null> {
  const cached = snapshotCache.get(platform);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snapshot;
  const pending = inFlight.get(platform);
  if (pending) return pending;

  const lookup = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Store release lookup timed out'));
      }, REQUEST_TIMEOUT_MS);
    });
    let snapshot: StoreReleaseSnapshot | null = null;
    try {
      // The deadline also bounds GitHub App token resolution, before fetch.
      snapshot = await Promise.race([fetchSnapshot(platform, controller.signal), deadline]);
    } catch {
      logger.warn(`[mobile-store-release] ${platform} lookup unavailable`);
    } finally {
      clearTimeout(timer);
      snapshotCache.set(platform, { at: Date.now(), snapshot });
      inFlight.delete(platform);
    }
    return snapshot;
  })();
  inFlight.set(platform, lookup);
  return lookup;
}

/** Fail closed: store metadata never makes another app query fail. */
export async function readMobileStoreRelease(
  platform: MobileStorePlatform,
  nativeVersion: string,
): Promise<MobileStoreRelease | null> {
  if ((platform !== 'ios' && platform !== 'android') || nativeVersion.length > 50) return null;
  const snapshot = await readSnapshot(platform);
  if (!snapshot) return null;
  return resolveMobileStoreRelease(snapshot, nativeVersion, STORE_URLS[platform], Date.now());
}

/** Test-only: forget independent platform caches. */
export function resetMobileStoreReleaseCache(): void {
  snapshotCache.clear();
  inFlight.clear();
}
