import { createAsyncStorage, type AsyncStorage } from '@react-native-async-storage/async-storage';

// The package default remains its legacy localStorage adapter for compatibility.
// Expo web opts into the v3 IndexedDB implementation explicitly instead.
const webAsyncStorage: AsyncStorage = createAsyncStorage('boardsesh-mobile-web');

export { createAsyncStorage };
export type { AsyncStorage };
export default webAsyncStorage;
