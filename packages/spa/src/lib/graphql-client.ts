import { GraphQLClient } from 'graphql-request'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

export const graphqlClient = new GraphQLClient(`${apiUrl}/graphql`, {
  credentials: 'include',
})

/**
 * Returns the WebSocket URL for GraphQL subscriptions.
 * Uses VITE_WS_URL if set, otherwise derives from VITE_API_URL.
 */
export function getWsUrl(): string {
  const wsUrl = import.meta.env.VITE_WS_URL
  if (wsUrl) return wsUrl

  // Derive WS URL from API URL by replacing http(s) with ws(s)
  return apiUrl.replace(/^http/, 'ws') + '/graphql'
}
