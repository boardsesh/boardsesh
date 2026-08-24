// The SecureStore key names for the party-session ids, owned here rather than by
// either session-store fork.
//
// session-store.ts has a session-store.web.ts sibling, and Metro resolves
// `./session-store` to whichever fork matches the build target. A key declared
// inside one fork is therefore invisible to the other — and to
// preference-secure-keys.ts, which imports these names to decide what the #4103
// keychain migration covers. Importing them through a forked module silently
// yields `undefined` on the target whose fork does not export them, punching
// holes in the migration list that neither tsc nor the native bundle can see.
//
// Both forks and the migration key list read from here so that cannot happen.

export const SESSION_ID_KEY = 'boardsesh_active_session_id';

export const CREATED_SESSION_ID_KEY = 'boardsesh_created_session_id';
