import * as WebBrowser from 'expo-web-browser';
import { reportError } from './error-reporting';

/**
 * Opens an external URL in the in-app browser, reporting (but swallowing) any
 * failure so a dead link never crashes the screen. Used for GitHub profile and
 * project links on the Acknowledgements / licenses screens.
 */
export async function openExternalUrl(url: string, source: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch (error) {
    reportError(error, { tags: { source } });
  }
}
