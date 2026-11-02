import type { AsyncStorage } from '@react-native-async-storage/async-storage';
import { createIndexedDbAsyncStorage } from './indexeddb-async-storage';

// The package default remains its legacy localStorage adapter for compatibility,
// and its v3 IndexedDB adapter keeps a dead connection after iOS Safari closes
// it (#5612). Expo web uses our own IndexedDB adapter instead: same database,
// version and object store, so data the package wrote is still read back.
const webAsyncStorage: AsyncStorage = createIndexedDbAsyncStorage('boardsesh-mobile-web');

export { createIndexedDbAsyncStorage as createAsyncStorage };
export type { AsyncStorage };
export default webAsyncStorage;
