import { getDevicePushToken, addPushTokenListener } from './setup';
import type { Subscription } from 'expo-notifications';

export type TokenRegistrationFn = (sessionId: string, token: string) => Promise<void>;
export type TokenUnregistrationFn = (sessionId: string, token: string) => Promise<void>;

const RETRY_DELAYS = [0, 2000, 5000, 15000, 30000];

let currentToken: string | null = null;
let currentSessionId: string | null = null;
let tokenRefreshSubscription: Subscription | null = null;

async function registerWithRetry(
  register: TokenRegistrationFn,
  sessionId: string,
  token: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    const delay = RETRY_DELAYS[attempt];
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      await register(sessionId, token);
      return true;
    } catch {
      if (attempt === RETRY_DELAYS.length - 1) return false;
    }
  }
  return false;
}

export async function startTokenManagement(
  sessionId: string,
  register: TokenRegistrationFn,
): Promise<void> {
  currentSessionId = sessionId;

  const token = await getDevicePushToken();
  if (!token) return;

  currentToken = token;
  await registerWithRetry(register, sessionId, token);

  tokenRefreshSubscription?.remove();
  tokenRefreshSubscription = addPushTokenListener(async (newToken) => {
    if (!currentSessionId) return;
    currentToken = newToken;
    await registerWithRetry(register, currentSessionId, newToken);
  });
}

export async function stopTokenManagement(
  unregister: TokenUnregistrationFn,
): Promise<void> {
  tokenRefreshSubscription?.remove();
  tokenRefreshSubscription = null;

  if (currentSessionId && currentToken) {
    try {
      await unregister(currentSessionId, currentToken);
    } catch {
      // Best effort — session may already be ended
    }
  }

  currentToken = null;
  currentSessionId = null;
}

export function getCurrentToken(): string | null {
  return currentToken;
}
