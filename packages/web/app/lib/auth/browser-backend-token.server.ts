import 'server-only';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';
import {
  issueBrowserCapabilityToken,
  type BrowserCapabilityTokenOptions,
  type BrowserCapabilityTokenResult,
} from './browser-capability-token.server';

export type BrowserBackendTokenResult = BrowserCapabilityTokenResult;

/** Fixed-purpose wrapper. Source possession, correlation and the full-roundtrip
 * deadline are shared; the two bearer families remain non-interchangeable. */
export function issueBrowserBackendToken(
  selection: AdmittedBrowserSelection,
  options: BrowserCapabilityTokenOptions = {},
): Promise<BrowserBackendTokenResult> {
  return issueBrowserCapabilityToken(selection, 'backend-delegation', options);
}
