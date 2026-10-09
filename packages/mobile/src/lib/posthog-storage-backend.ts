import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const posthogStorageBackend = {
  async getItem(key: string): Promise<string | null> {
    const file = new File(Paths.document, key);
    return file.exists ? file.text() : null;
  },
  async setItem(key: string, payload: string): Promise<void> {
    new File(Paths.document, key).write(payload);
  },
  async removeItem(key: string): Promise<void> {
    const file = new File(Paths.document, key);
    if (file.exists) file.delete();
    // Earlier SDK releases fell back to AsyncStorage when filesystem storage was unavailable.
    await AsyncStorage.removeItem(key);
  },
};
