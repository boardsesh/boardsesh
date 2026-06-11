import type { Client, Sink } from 'graphql-ws';
import { GraphQLOperationError, parseRateLimitError } from './errors';

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
          const operationError = new GraphQLOperationError(data.errors);
          sink.error?.(parseRateLimitError(operationError) ?? operationError);
        }
      },
      error: (error) => {
        // graphql-ws passes raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket
        // connection fails. Always forward a proper Error so callers and Sentry never
        // receive "Event `Event` (type=error) captured as promise rejection".
        if (Array.isArray(error) && error.length > 0 && typeof error[0]?.message === 'string') {
          const operationError = new GraphQLOperationError(error);
          sink.error?.(parseRateLimitError(operationError) ?? operationError);
          return;
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        sink.error?.(parseRateLimitError(normalizedError) ?? normalizedError);
      },
      complete: () => {
        sink.complete?.();
      },
    },
  );
}
