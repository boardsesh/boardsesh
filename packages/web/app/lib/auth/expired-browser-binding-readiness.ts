/** Real writer coordination, cookie-order and device gates remain in #7430.
 * Environment variables cannot enable this public browser action. */
export function publicExpiredBrowserBindingReady(): boolean {
  return false;
}
