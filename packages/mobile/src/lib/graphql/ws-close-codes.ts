// graphql-ws WebSocket close codes for the auth-refresh reconnect handshake.
// Kept in a dedicated, dependency-free module so the session-realtime consumer
// reads the same values the ws-client transports emit — and so the many test
// files that `vi.mock('../../lib/graphql/ws-client')` don't strip the constant
// out from under the consumer (which would silently degrade the rejoin path).

// graphql-ws treats 4401 as fatal before it invokes shouldRetry: the backend
// closes an auth-rejected handshake with it.
export const AUTH_REJECTED_CLOSE_CODE = 4401;
// 4403 is not in graphql-ws' fatal-code list, so remapping a rejected handshake
// to it lets active operations run through the normal reconnect and resubscribe
// loop once credentials refresh.
export const AUTH_REFRESH_RETRY_CLOSE_CODE = 4403;
