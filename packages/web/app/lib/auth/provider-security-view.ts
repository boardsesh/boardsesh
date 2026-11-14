import { browserBackendSessionKey } from '@boardsesh/auth-protocol/browser-backend-session';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';

export const PROVIDER_SETTINGS_VIEW_HEADER = 'X-Boardsesh-Provider-View';
export const PROVIDER_SETTINGS_OPERATION_HEADER = 'X-Boardsesh-Provider-Operation';

/** Correlates the accepted UI view with a primary-selected actor. This public
 * metadata never admits a credential or supplies authentication freshness. */
export function providerSettingsViewFrame(owner: BrowserBackendLeaseOwner): string {
  return JSON.stringify(['provider-settings-view-v1', browserBackendSessionKey(owner)]);
}
