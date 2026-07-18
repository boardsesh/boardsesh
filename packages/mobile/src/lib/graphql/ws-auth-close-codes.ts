// Close codes for the rejected-auth GraphQL-WS handshake. Shared by the two
// sides of the auth-recovery dance so they can never silently diverge:
//   - `ws-client-core.ts` (the transport) remaps a rejected 4401 close to 4403.
//   - `use-session-realtime.ts` (the session engine) detects that 4403 to keep
//     established subscriptions alive across the retry.
// If these values drifted, the transport would retry but the engine would tear
// the subscriptions down (or vice versa), breaking subscription retention with
// no error.

/**
 * The backend closes a rejected-auth handshake with 4401. graphql-ws treats
 * 4401 as fatal *before* invoking `shouldRetry`, so left as-is it would abort
 * active operations instead of reconnecting.
 */
export const AUTH_REJECTED_CLOSE_CODE = 4401;

/**
 * The transport remaps that rejected 4401 to 4403 at its boundary. 4403 is not
 * in graphql-ws' fatal-code list, so exposing the rejected handshake as 4403
 * lets active operations run through graphql-ws' normal reconnect and
 * resubscribe loop once the credential has been refreshed.
 */
export const AUTH_REFRESH_RETRY_CLOSE_CODE = 4403;
