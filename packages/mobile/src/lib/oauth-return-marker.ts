export const WEB_OAUTH_RETURN_PROVIDER_PARAM = 'boardseshOAuthProvider';
export const WEB_OAUTH_RETURN_ATTEMPT_PARAM = 'boardseshOAuthAttempt';
export const WEB_OAUTH_RETURN_ERROR_PARAM = 'boardseshOAuthError';

export function createWebOAuthAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
