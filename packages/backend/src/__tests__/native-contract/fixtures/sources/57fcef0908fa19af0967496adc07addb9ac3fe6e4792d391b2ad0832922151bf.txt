import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';

const JWT_KEY = 'boardsesh_jwt';
const REFRESH_TOKEN_KEY = 'boardsesh_refresh_token';
const EXPIRES_AT_KEY = 'boardsesh_token_expires_at';

export async function getAuthToken(): Promise<string | null> {
  return SecureStore.getItemAsync(JWT_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function getTokenExpiresAt(): Promise<Date | null> {
  const value = await SecureStore.getItemAsync(EXPIRES_AT_KEY);
  return value ? new Date(value) : null;
}

export async function storeTokens(jwt: string, refreshToken: string, expiresAt: string): Promise<void> {
  await SecureStore.setItemAsync(JWT_KEY, jwt, SECURE_STORE_WRITE_OPTIONS);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, SECURE_STORE_WRITE_OPTIONS);
  await SecureStore.setItemAsync(EXPIRES_AT_KEY, expiresAt, SECURE_STORE_WRITE_OPTIONS);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(JWT_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(EXPIRES_AT_KEY),
  ]);
}

export async function isTokenExpiringSoon(): Promise<boolean> {
  const expiresAt = await getTokenExpiresAt();
  if (!expiresAt) return true;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return expiresAt.getTime() - Date.now() < oneDayMs;
}
