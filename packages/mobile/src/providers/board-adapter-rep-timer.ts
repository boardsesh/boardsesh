import { tickTimeMs } from '@boardsesh/profile-stats';

type SessionTickTimestamp = {
  userId?: string | null;
  climbedAt: string;
};

export type LocalSessionTick = {
  sessionId: string;
  climbedAt: string;
};

export function getLatestUserSessionTickAt(
  ticks: readonly SessionTickTimestamp[] | undefined,
  userId: string | null | undefined,
): string | null {
  if (!ticks || !userId) return null;

  let latestTickAt: string | null = null;
  let latestTickMs = -Infinity;

  for (const tick of ticks) {
    if (tick.userId !== userId) continue;

    const tickMs = tickTimeMs(tick.climbedAt);
    if (!Number.isFinite(tickMs) || tickMs <= latestTickMs) continue;

    latestTickAt = tick.climbedAt;
    latestTickMs = tickMs;
  }

  return latestTickAt;
}

export function getNewerTickAt(firstTickAt: string | null, secondTickAt: string | null): string | null {
  if (!firstTickAt) return secondTickAt;
  if (!secondTickAt) return firstTickAt;

  const firstMs = tickTimeMs(firstTickAt);
  const secondMs = tickTimeMs(secondTickAt);

  if (!Number.isFinite(firstMs)) return Number.isFinite(secondMs) ? secondTickAt : null;
  if (!Number.isFinite(secondMs)) return firstTickAt;

  return firstMs >= secondMs ? firstTickAt : secondTickAt;
}

export function mergeSavedSessionTick(
  currentTick: LocalSessionTick | null,
  sessionId: string,
  climbedAt: string,
): LocalSessionTick | null {
  const currentTickAt = currentTick?.sessionId === sessionId ? currentTick.climbedAt : null;
  const newerTickAt = getNewerTickAt(currentTickAt, climbedAt);
  return newerTickAt ? { sessionId, climbedAt: newerTickAt } : currentTick;
}
