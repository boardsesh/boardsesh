import { tickTimeMs } from '@boardsesh/profile-stats';

export function getRepTimerElapsedSeconds(lastSavedTickAt: string | null, nowMs: number): number {
  if (!lastSavedTickAt) return 0;
  const tickMs = tickTimeMs(lastSavedTickAt);
  if (!Number.isFinite(tickMs)) return 0;
  return Math.max(0, Math.floor((nowMs - tickMs) / 1000));
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
