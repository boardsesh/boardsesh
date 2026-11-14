/** The source graph cannot activate public renewal through environment values.
 * Browser response-order, recovery, retention and adoption gates stay in #7430. */
export function publicBrowserRenewalReady(): boolean {
  return false;
}
