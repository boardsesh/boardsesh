import type { PartnerAuthorityRuntime } from './authority';
import { readPartnerOAuthMode } from './mode';

/**
 * The only way the backend reaches the partner authority. With the mode `off`
 * this returns before any Better Auth code loads, so importing this module
 * constructs nothing, opens no connections and starts no telemetry.
 */
export async function loadPartnerAuthority(mode = readPartnerOAuthMode()): Promise<PartnerAuthorityRuntime | null> {
  if (mode === 'off') return null;
  const { getPartnerAuthorityRuntime } = await import('./authority');
  return getPartnerAuthorityRuntime();
}
