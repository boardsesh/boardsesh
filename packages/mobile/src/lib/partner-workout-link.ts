export const PENDING_APP_WORKOUT_KEY = 'boardsesh_pending_app_workout_id';
export const isAppWorkoutId = (id: unknown): id is string =>
  typeof id === 'string' && /^wk_[A-Za-z0-9_-]{1,128}$/.test(id);

/** Only our own links can become a post-login destination. */
export function parseAppWorkoutId(url: string): string | null {
  const path = url
    .replace(/^com\.boardsesh\.app:\/\//, '/')
    .replace(/^https:\/\/(?:www\.|app\.)?boardsesh\.com(?=\/)/, '');
  const match = /^\/(?:[a-z]{2}\/)?w\/(wk_[A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/.exec(path);
  return match?.[1] ?? null;
}

export const PENDING_APP_WORKOUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function serializePendingAppWorkout(workoutId: string, now = Date.now()): string {
  return JSON.stringify({ workoutId, stashedAt: now });
}
export function readPendingAppWorkout(stored: string | null, now = Date.now()): string | null {
  if (!stored) return null;
  try {
    const candidate: unknown = JSON.parse(stored);
    if (!candidate || typeof candidate !== 'object') return null;
    const { workoutId, stashedAt } = candidate as { workoutId?: unknown; stashedAt?: unknown };
    if (!isAppWorkoutId(workoutId) || typeof stashedAt !== 'number' || !Number.isFinite(stashedAt)) return null;
    const age = now - stashedAt;
    return age >= 0 && age <= PENDING_APP_WORKOUT_MAX_AGE_MS ? workoutId : null;
  } catch {
    return null;
  }
}
