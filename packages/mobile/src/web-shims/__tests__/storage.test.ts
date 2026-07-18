import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storedValues, indexedDbStorage, createAsyncStorage } = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    getMany: vi.fn(),
    setMany: vi.fn(),
    removeMany: vi.fn(),
    getAllKeys: vi.fn(),
    clear: vi.fn(),
  };
  return { storedValues: values, indexedDbStorage: storage, createAsyncStorage: vi.fn(() => storage) };
});

vi.mock('@react-native-async-storage/async-storage', () => ({ createAsyncStorage }));

import AsyncStorage from '../async-storage';
import * as SecureStore from '../secure-store';

describe('Expo web storage shims', () => {
  beforeEach(() => {
    storedValues.clear();
    indexedDbStorage.getItem.mockClear();
    indexedDbStorage.setItem.mockClear();
    indexedDbStorage.removeItem.mockClear();
  });

  it('constructs the v3 IndexedDB adapter instead of using legacy localStorage', () => {
    expect(createAsyncStorage).toHaveBeenCalledWith('boardsesh-mobile-web');
    expect(AsyncStorage).toBe(indexedDbStorage);
  });

  it('namespaces SecureStore-compatible preferences in IndexedDB', async () => {
    await SecureStore.setItemAsync('theme', 'dark');
    expect(indexedDbStorage.setItem).toHaveBeenCalledWith('secure:theme', 'dark');
    await expect(SecureStore.getItemAsync('theme')).resolves.toBe('dark');

    await SecureStore.deleteItemAsync('theme');
    await expect(SecureStore.getItemAsync('theme')).resolves.toBeNull();
  });

  it('does not pretend IndexedDB supports synchronous reads', () => {
    expect(SecureStore.getItem('theme')).toBeNull();
  });

  it('refuses secret-looking keys so real credentials never land in plaintext IndexedDB', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(SecureStore.setItemAsync('backend_auth_token', 'jwe')).rejects.toThrow(/secret material/);
    expect(() => SecureStore.setItem('refresh_token', 'value')).toThrow(/secret material/);
    expect(indexedDbStorage.setItem).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('still allows non-secret preference and session-id keys', async () => {
    await expect(SecureStore.setItemAsync('boardsesh_active_session_id', 'session-1')).resolves.toBeUndefined();
    expect(indexedDbStorage.setItem).toHaveBeenCalledWith('secure:boardsesh_active_session_id', 'session-1');
  });
});
