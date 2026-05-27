import type { Client, Sink } from 'graphql-ws';

/**
 * Subscribe to a GraphQL subscription and receive events via callback.
 * Returns an unsubscribe function. Wraps `Client.subscribe` to coerce
 * graphql-ws's raw DOM error events into proper `Error` instances and to
 * flatten `data.errors` arrays into the `error` sink.
 */
export function subscribe<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  sink: Sink<TData>,
): () => void {
  return client.subscribe<TData>(
    { query: operation.query, variables: operation.variables as Record<string, unknown> },
    {
      next: (data) => {
        if (data.data) {
          sink.next?.(data.data);
        }
        if (data.errors) {
          sink.error?.(new Error(data.errors.map((e) => e.message).join(', ')));
        }
      },
      error: (error) => {
        // graphql-ws passes raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket
        // connection fails. Always forward a proper Error so callers and Sentry never
        // receive "Event `Event` (type=error) captured as promise rejection".
        sink.error?.(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        sink.complete?.();
      },
    },
  );
}
