import { tickTimeMs } from '@boardsesh/profile-stats';

export function getRepTimerStartMs(lastSavedTickAt: string | null): number | null {
  if (!lastSavedTickAt) return null;
  const tickMs = tickTimeMs(lastSavedTickAt);
  return Number.isFinite(tickMs) ? tickMs : null;
}

export function getRepTimerElapsedSecondsFromStart(startMs: number | null, nowMs: number): number {
  if (startMs === null) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

export function getRepTimerElapsedSeconds(lastSavedTickAt: string | null, nowMs: number): number {
  return getRepTimerElapsedSecondsFromStart(getRepTimerStartMs(lastSavedTickAt), nowMs);
}

export function isRepTimerTargetReached(elapsedSeconds: number, targetSeconds: number): boolean {
  return elapsedSeconds >= targetSeconds;
}

export function isRepTimerTargetExceeded(elapsedSeconds: number, targetSeconds: number): boolean {
  return elapsedSeconds > targetSeconds;
}

export function formatRepTimerTarget(targetSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(targetSeconds));
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60}m`;
  return formatRepTimerElapsed(totalSeconds);
}

export function formatRepTimerElapsed(elapsedSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = seconds.toString().padStart(2, '0');

  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`;
  }

  return `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`;
}
