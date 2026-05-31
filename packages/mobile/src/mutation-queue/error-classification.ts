type GraphqlErrorEntry = {
  extensions?: { code?: unknown; status?: unknown };
};

function statusFromGraphqlErrors(errors: unknown): number | null {
  if (!Array.isArray(errors)) return null;
  for (const entry of errors as GraphqlErrorEntry[]) {
    const extensions = entry?.extensions;
    if (extensions && typeof extensions.code === 'number') {
      return extensions.code;
    }
    if (extensions && typeof extensions.status === 'number') {
      return extensions.status;
    }
  }
  return null;
}

export function getErrorStatus(error: unknown): number | null {
  if (error instanceof Response) {
    return error.status;
  }

  if (error && typeof error === 'object') {
    if ('status' in error && typeof (error as Record<string, unknown>).status === 'number') {
      return (error as Record<string, unknown>).status as number;
    }

    if ('response' in error) {
      const response = (error as Record<string, unknown>).response;
      if (response && typeof response === 'object') {
        // HTTP status surfaced under .response.status
        if ('status' in response && typeof (response as Record<string, unknown>).status === 'number') {
          return (response as Record<string, unknown>).status as number;
        }
        // graphql-request's ClientError nests GraphQL errors under .response.errors
        const nestedStatus = statusFromGraphqlErrors((response as Record<string, unknown>).errors);
        if (nestedStatus !== null) {
          return nestedStatus;
        }
      }
    }

    if ('errors' in error) {
      const topLevelStatus = statusFromGraphqlErrors((error as Record<string, unknown>).errors);
      if (topLevelStatus !== null) {
        return topLevelStatus;
      }
    }
  }

  return null;
}

export function isRetryable(error: unknown): boolean {
  // Network failures (TypeError with a network/fetch message) always retry —
  // the request never reached the server, so replaying it is safe.
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (message.includes('network') || message.includes('fetch')) {
      return true;
    }
  }

  const status = getErrorStatus(error);

  // No resolvable HTTP/GraphQL status and not a recognized network error: most
  // likely a programmer / validation / parse bug. Dead-letter it (I5) so it's
  // surfaced to the user instead of silently burning the retry budget.
  if (status === null) {
    return false;
  }

  if (status === 401) return true;
  if (status === 429) return true;
  if (status >= 500) return true;

  return false;
}
