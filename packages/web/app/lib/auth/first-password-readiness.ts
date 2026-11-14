/** Public browser qualification is recorded separately from implementation.
 * Request fields and deployment variables cannot override this code-owned gate. */
export function publicFirstPasswordReady(): boolean {
  return false;
}
