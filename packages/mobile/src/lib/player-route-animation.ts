/** Android's player owns its short sheet motion on the UI thread. */
export function getPlayerRouteAnimation(platform: string): 'none' | 'slide_from_bottom' {
  return platform === 'android' ? 'none' : 'slide_from_bottom';
}

export const ANDROID_PLAYER_TRANSITION_MS = 200;
