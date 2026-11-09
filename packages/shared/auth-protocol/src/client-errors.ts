/** Safe public NextAuth error only; never include transport error messages. */
export const AUTH_BACKEND_UNAVAILABLE = 'AuthBackendUnavailable';

export function isAuthBackendUnavailable(error: unknown): boolean {
  return error === AUTH_BACKEND_UNAVAILABLE;
}
