/**
 * The route's one door into the lab. A require, not an import, so the screen
 * and everything under it run only once the route has confirmed access, never
 * on the startup path.
 */
export function loadBoardMotionLabScreen(): typeof import('./screen').default {
  return (require('./screen') as typeof import('./screen')).default;
}
