import AsyncStorage from '@react-native-async-storage/async-storage';

export const posthogStorageBackend = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, payload: string) => AsyncStorage.setItem(key, payload),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};
