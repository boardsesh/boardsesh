/** The integration harness is opt-in, dev-only, and absent from store bundles. */
export function loadIntegrationSmoke(): typeof import('./smoke') | null {
  return __DEV__ && (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || !!process.env.EXPO_PUBLIC_SCREENSHOT_SMOKE_URL)
    ? (require('./smoke') as typeof import('./smoke'))
    : null;
}

export function loadIntegrationBootstrap(): typeof import('./bootstrap').IntegrationBootstrap | null {
  return __DEV__ && (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || !!process.env.EXPO_PUBLIC_SCREENSHOT_SMOKE_URL)
    ? (require('./bootstrap') as typeof import('./bootstrap')).IntegrationBootstrap
    : null;
}
