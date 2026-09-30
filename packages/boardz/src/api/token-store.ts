import * as SecureStore from 'expo-secure-store';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token stops working. */
  expiresAt: string;
};

const STORAGE_KEY = 'boardz.auth.tokens';

// Every request reads the token, so keep it in memory after the first keychain read.
let cached: TokenPair | null | undefined;
// Every request retries an unreadable keychain; one warning per run is enough.
let warnedUnreadable = false;

function isTokenPair(value: unknown): value is TokenPair {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiresAt === 'string'
  );
}

export async function readTokens(): Promise<TokenPair | null> {
  if (cached !== undefined) return cached;
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(STORAGE_KEY);
  } catch (error) {
    // An unreadable keychain (a locked phone, or a simulator build without the
    // keychain entitlement) means no saved session, not a failed request:
    // public climbs still load. Not cached, so the next read tries again.
    if (__DEV__ && !warnedUnreadable) console.warn('Could not read the saved sign-in:', error);
    warnedUnreadable = true;
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cached = isTokenPair(parsed) ? parsed : null;
  return cached;
}

/** Save a session. If the keychain refuses, the session lasts until the app closes. */
export async function writeTokens(tokens: TokenPair): Promise<void> {
  cached = tokens;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tokens));
  } catch (error) {
    if (__DEV__) console.warn('Could not save the sign-in; it will last until the app closes:', error);
  }
}

/** Forget the session. Signing out always works on the phone, even if the keychain refuses. */
export async function clearTokens(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch (error) {
    if (__DEV__) console.warn('Could not remove the saved sign-in:', error);
  }
}
