import { getDevicePushToken, addPushTokenListener } from './setup';
import type { Subscription } from 'expo-notifications';

export type TokenRegistrationFn = (sessionId: string, token: string) => Promise<void>;
export type TokenUnregistrationFn = (sessionId: string, token: string) => Promise<void>;

const RETRY_DELAYS = [0, 2000, 5000, 15000, 30000];

// Spread out retries so a fleet of devices refreshing at once doesn't stampede
// the backend in lockstep. Each delay is randomised within ±20% of its base.
const JITTER_RATIO = 0.2;

function withJitter(baseDelay: number): number {
  if (baseDelay <= 0) return baseDelay;
  const spread = baseDelay * JITTER_RATIO;
  const offset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(baseDelay + offset));
}

let currentToken: string | null = null;
let currentSessionId: string | null = null;
let tokenRefreshSubscription: Subscription | null = null;

async function registerWithRetry(register: TokenRegistrationFn, sessionId: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    const delay = withJitter(RETRY_DELAYS[attempt]);
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

export async function startTokenManagement(sessionId: string, register: TokenRegistrationFn): Promise<void> {
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

export async function stopTokenManagement(unregister: TokenUnregistrationFn): Promise<void> {
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
