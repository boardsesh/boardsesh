import { BACKEND_URL } from './env';
import { timeoutSignal } from './timeout-signal';
import { clearTokens, readTokens, writeTokens, type TokenPair } from './token-store';

// Boardsesh's password sign-in and token refresh (packages/backend/src/handlers/native-auth.ts).
// Refresh tokens are single use: every refresh revokes the old one and returns a
// new pair. Two refreshes racing would sign the climber out, so there is only
// ever one in flight.

type TokenResponse = { jwt: string; refreshToken: string; expiresAt: string };

export type SignInResult = { ok: true } | { ok: false; message: string };

const REQUEST_TIMEOUT_MS = 15_000;
// Refresh a little before expiry so a request never goes out with a dying token.
const EXPIRY_MARGIN_MS = 60_000;

type SignedOutListener = () => void;
const signedOutListeners = new Set<SignedOutListener>();

/** Called when the backend rejects the session, so the UI can show sign-in again. */
export function onSignedOut(listener: SignedOutListener): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

function toTokenPair(response: TokenResponse): TokenPair {
  return { accessToken: response.jwt, refreshToken: response.refreshToken, expiresAt: response.expiresAt };
}

async function postJson(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null;
  } catch {
    return null;
  }
}

export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  let response: Response;
  try {
    response = await postJson('/auth/native/credentials', { email: email.trim(), password });
  } catch {
    return { ok: false, message: 'Could not reach Boardsesh. Check your connection and try again.' };
  }

  if (!response.ok) {
    if (response.status === 401) {
      return {
        ok: false,
        message:
          'That email and password did not match. If you usually sign in with Apple or Google, set a password on boardsesh.com first.',
      };
    }
    const serverMessage = await readErrorMessage(response);
    return { ok: false, message: serverMessage ?? `Sign-in failed (HTTP ${response.status}).` };
  }

  await writeTokens(toTokenPair((await response.json()) as TokenResponse));
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const tokens = await readTokens();
  await clearTokens();
  if (tokens) {
    // Best effort: the session is already gone on this phone either way.
    postJson('/auth/native/revoke', { refreshToken: tokens.refreshToken }).catch(() => {});
  }
}

type RefreshOutcome = 'refreshed' | 'rejected' | 'unavailable';
let refreshInFlight: Promise<RefreshOutcome> | null = null;

async function runRefresh(): Promise<RefreshOutcome> {
  const tokens = await readTokens();
  if (!tokens) return 'rejected';
  let response: Response;
  try {
    response = await postJson('/auth/native/refresh', { refreshToken: tokens.refreshToken });
  } catch {
    return 'unavailable';
  }
  if (response.status === 401 || response.status === 403) {
    await clearTokens();
    signedOutListeners.forEach((listener) => listener());
    return 'rejected';
  }
  if (!response.ok) return 'unavailable';
  await writeTokens(toTokenPair((await response.json()) as TokenResponse));
  return 'refreshed';
}

/** Refresh the token pair, joining a refresh that is already running. */
export function refreshSession(): Promise<RefreshOutcome> {
  refreshInFlight ??= runRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** The access token to send, refreshed first when it is about to expire. Null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  const tokens = await readTokens();
  if (!tokens) return null;
  const expiresAtMs = Date.parse(tokens.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() < EXPIRY_MARGIN_MS) {
    // An unreachable refresh keeps the old token: the server's 401 is the real answer.
    await refreshSession();
    return (await readTokens())?.accessToken ?? null;
  }
  return tokens.accessToken;
}
