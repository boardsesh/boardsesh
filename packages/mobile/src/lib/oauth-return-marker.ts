export const WEB_OAUTH_RETURN_PROVIDER_PARAM = 'boardseshOAuthProvider';
export const WEB_OAUTH_RETURN_ATTEMPT_PARAM = 'boardseshOAuthAttempt';
export const WEB_OAUTH_RETURN_ERROR_PARAM = 'boardseshOAuthError';
export const WEB_OAUTH_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function createWebOAuthAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure random number generation is unavailable');
  }
  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
