/** "Off", "45 s", "2 min", "2 min 30 s": a rest or interval setting. */
export function formatSeconds(seconds: number): string {
  if (seconds <= 0) return 'Off';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder} s`;
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
}

/** "Off", "45s", "2:00", "2:30": the same setting as a mono figure, so steppers line up. */
export function formatSecondsShort(seconds: number): string {
  if (seconds <= 0) return 'Off';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "2:05" for a countdown, rounding up so it reads 0:01 until the moment it ends. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
