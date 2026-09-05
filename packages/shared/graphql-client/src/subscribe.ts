// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { Client, Sink } from 'graphql-ws';
import { GraphQLOperationError } from './errors';

/** True for a graphql-ws error payload shaped like `GraphQLError[]`. */
function isGraphQLErrorArray(
  value: unknown,
): value is Array<{ message: string; extensions?: Record<string, unknown> }> {
  return Array.isArray(value) && value.length > 0 && typeof value[0]?.message === 'string';
}

/**
 * Subscribe to a GraphQL subscription and receive events via callback.
 * Returns an unsubscribe function. Wraps `Client.subscribe` to coerce
 * graphql-ws's raw DOM error events into proper `Error` instances and to
 * forward `data.errors` (and error-callback arrays) as `GraphQLOperationError`
 * so callers can classify them — e.g. a rate-limited board-presence
 * subscription surfaces its `RATE_LIMITED` extension via `isRateLimitedError`
 * instead of being flattened into a message-only `Error`.
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
          sink.error?.(new GraphQLOperationError(data.errors));
        }
      },
      error: (error) => {
        // graphql-ws passes raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket
        // connection fails, and a `GraphQLError[]` when the server closes the stream
        // with errors. Preserve extensions in the latter case (so RATE_LIMITED stays
        // classifiable); otherwise always forward a proper Error so callers and Sentry
        // never receive "Event `Event` (type=error) captured as promise rejection".
        if (isGraphQLErrorArray(error)) {
          sink.error?.(new GraphQLOperationError(error));
        } else {
          sink.error?.(error instanceof Error ? error : new Error(String(error)));
        }
      },
      complete: () => {
        sink.complete?.();
      },
    },
  );
}
