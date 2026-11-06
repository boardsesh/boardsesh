/** Android's native fade is nominally 150 ms; its slide uses system medium timing. */
export function getPlayerRouteAnimation(platform: string): 'fade' | 'slide_from_bottom' {
  return platform === 'android' ? 'fade' : 'slide_from_bottom';
}
