import type { AuthProvider } from './auth';

export type WebOAuthReturn = {
  provider: AuthProvider;
  attemptId: string;
  error: string | null;
};

export function consumeWebOAuthReturn(): WebOAuthReturn | null {
  return null;
}
