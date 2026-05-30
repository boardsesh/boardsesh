// The store implementation lives in `@boardsesh/climb-actions` so mobile and
// web share one singleton-pattern class. Re-exported here so existing web
// imports (`import { favoritesStore } from './favorites-store'`) keep working.
export { favoritesStore, FavoritesStore } from '@boardsesh/climb-actions';
