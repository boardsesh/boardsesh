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
