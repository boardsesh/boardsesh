import {
  compareNumericVersions,
  parseNumericVersion,
  type MobileStoreRelease,
} from '@boardsesh/shared-schema/mobile-store-release';
import { hasNudgeCooldownElapsed } from '../nudge-cooldown';

export const DAY_MS = 24 * 60 * 60 * 1000;
export type StoreUpdateStage = 'weekly' | 'frequent' | 'daily';
export type StoreUpdateAcknowledgment = { nativeVersion: string; lastAcknowledgedAtMs: number };

export function parseStoreUpdateAcknowledgment(stored: unknown): StoreUpdateAcknowledgment | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const record = stored as Record<string, unknown>;
  const nativeVersion = typeof record.nativeVersion === 'string' ? parseNumericVersion(record.nativeVersion) : null;
  if (
    !nativeVersion ||
    typeof record.lastAcknowledgedAtMs !== 'number' ||
    !Number.isFinite(record.lastAcknowledgedAtMs) ||
    record.lastAcknowledgedAtMs < 0
  )
    return null;
  return { nativeVersion: nativeVersion.join('.'), lastAcknowledgedAtMs: record.lastAcknowledgedAtMs };
}

export function getStoreUpdateStage(input: {
  release: MobileStoreRelease | null;
  nativeVersion: string | null;
  acknowledgment: StoreUpdateAcknowledgment | null;
  nowMs: number;
}): StoreUpdateStage | null {
  const { release, nativeVersion, acknowledgment, nowMs } = input;
  const installed = parseNumericVersion(nativeVersion);
  const latest = parseNumericVersion(release?.latestVersion);
  if (!release || !installed || !latest || !Number.isFinite(nowMs)) return null;
  const comparison = compareNumericVersions(release.latestVersion, installed.join('.'));
  if (comparison === null || comparison <= 0) return null;
  if (latest[0] === installed[0] && latest[1] === installed[1]) return null;
  const checkedAtMs = Date.parse(release.checkedAt);
  const firstAvailableAtMs = Date.parse(release.firstNewerMinorAvailableAt);
  if (
    !Number.isFinite(checkedAtMs) ||
    !Number.isFinite(firstAvailableAtMs) ||
    checkedAtMs > nowMs ||
    nowMs - checkedAtMs > DAY_MS ||
    firstAvailableAtMs > checkedAtMs
  )
    return null;
  const ageMs = nowMs - firstAvailableAtMs;
  if (ageMs < 14 * DAY_MS) return null;
  const stage: StoreUpdateStage = ageMs >= 60 * DAY_MS ? 'daily' : ageMs >= 30 * DAY_MS ? 'frequent' : 'weekly';
  const cooldownMs = (stage === 'daily' ? 1 : stage === 'frequent' ? 3 : 7) * DAY_MS;
  const acknowledgedAtMs =
    acknowledgment?.nativeVersion === installed.join('.') ? acknowledgment.lastAcknowledgedAtMs : null;
  return hasNudgeCooldownElapsed(nowMs, acknowledgedAtMs, cooldownMs) ? stage : null;
}

/** An explicit local fixture may opt into dev/screenshot rendering, never a production bundle. */
export function readStoreUpdateQaStage(): StoreUpdateStage | 'current' | null {
  if (!__DEV__) return null;
  const stage = process.env.EXPO_PUBLIC_STORE_UPDATE_QA_STAGE;
  return stage === 'weekly' || stage === 'frequent' || stage === 'daily' || stage === 'current' ? stage : null;
}

export function makeStoreUpdateQaRelease(
  stage: StoreUpdateStage | 'current',
  nowMs: number,
): MobileStoreRelease | null {
  if (stage === 'current') return null;
  return {
    latestVersion: '2.7.0',
    firstNewerMinorAvailableAt: new Date(
      nowMs - (stage === 'daily' ? 60 : stage === 'frequent' ? 30 : 14) * DAY_MS,
    ).toISOString(),
    checkedAt: new Date(nowMs).toISOString(),
    storeUrl: 'https://apps.apple.com/app/boardsesh/id6761350784',
  };
}
