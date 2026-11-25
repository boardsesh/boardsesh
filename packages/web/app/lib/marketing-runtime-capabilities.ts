/** Public service configuration that cannot be baked into static marketing HTML. */
export type MarketingRuntimeCapabilities = {
  enableExpoAuthBridge: boolean;
  developerHref: '/developers' | '/docs';
  hasMonthlySupport: boolean;
};

export function parseMarketingRuntimeCapabilities(candidate: unknown): MarketingRuntimeCapabilities | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const capabilities = candidate as Record<string, unknown>;
  if (
    typeof capabilities.enableExpoAuthBridge !== 'boolean' ||
    typeof capabilities.hasMonthlySupport !== 'boolean' ||
    (capabilities.developerHref !== '/developers' && capabilities.developerHref !== '/docs')
  )
    return null;
  return {
    enableExpoAuthBridge: capabilities.enableExpoAuthBridge,
    developerHref: capabilities.developerHref,
    hasMonthlySupport: capabilities.hasMonthlySupport,
  };
}
