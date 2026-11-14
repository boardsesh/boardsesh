import 'server-only';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';
import {
  issueBrowserCapabilityToken,
  type BrowserCapabilityTokenOptions,
  type BrowserCapabilityTokenResult,
} from './browser-capability-token.server';

export type NativeBrowserHandoffTokenResult = BrowserCapabilityTokenResult;

/** Fixed-purpose wrapper. Source possession, correlation and the full-roundtrip
 * deadline are shared; the two bearer families remain non-interchangeable. */
export function issueNativeBrowserHandoffToken(
  selection: AdmittedBrowserSelection,
  options: BrowserCapabilityTokenOptions = {},
): Promise<NativeBrowserHandoffTokenResult> {
  return issueBrowserCapabilityToken(selection, 'native-handoff', options);
}
