/** Reviewed public browser/callback qualification must precede activation.
 * Environment variables and request claims cannot select this readiness floor. */
export function publicProviderSecurityReady(): boolean {
  return false;
}
