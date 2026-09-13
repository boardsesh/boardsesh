// The app database's filename, on its own so leaf modules can read it without
// importing `./connection` — which imports them back. `connection.ts` re-exports
// it, so every existing `from '../db'` / `from './connection'` import is unchanged.
export const DATABASE_NAME = 'boardsesh.db';
