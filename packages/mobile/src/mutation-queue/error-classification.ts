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
      if (response && typeof response === 'object' && 'status' in response) {
        return (response as Record<string, unknown>).status as number;
      }
    }

    if ('errors' in error && Array.isArray((error as Record<string, unknown>).errors)) {
      const errors = (error as Record<string, unknown>).errors as Array<Record<string, unknown>>;
      for (const graphqlError of errors) {
        const extensions = graphqlError.extensions as Record<string, unknown> | undefined;
        if (extensions && typeof extensions.code === 'number') {
          return extensions.code as number;
        }
        if (extensions && typeof extensions.status === 'number') {
          return extensions.status as number;
        }
      }
    }
  }

  return null;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (message.includes('network') || message.includes('fetch')) {
      return true;
    }
  }

  const status = getErrorStatus(error);
  if (status === null) {
    return true;
  }

  if (status === 401) return true;
  if (status === 429) return true;
  if (status >= 500) return true;

  return false;
}
