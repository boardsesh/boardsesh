import AsyncStorage from '@react-native-async-storage/async-storage';

/** Read a stored JSON value, or null when it is missing, corrupt or the wrong shape. */
export async function readJson<T>(key: string, isValid: (value: unknown) => value is T): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Store a JSON value. Failures are swallowed: losing a preference must never crash the app. */
export function writeJson(key: string, value: unknown): void {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
}

export function removeStored(key: string): void {
  AsyncStorage.removeItem(key).catch(() => {});
}
