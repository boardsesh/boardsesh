/** Extract only a GraphQL operation name, never its variables or query text. */
export function diagnosticGraphqlOperationName(body: unknown): string {
  if (typeof body !== 'string' || body.length > 256_000) return 'graphql.request';
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return 'graphql.request';
    const request = parsed as { operationName?: unknown; query?: unknown };
    if (typeof request.operationName === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(request.operationName)) {
      return request.operationName;
    }
    if (typeof request.query === 'string') {
      return (
        /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]{0,63})(?=[\s({])/.exec(request.query)?.[1] ??
        'graphql.request'
      );
    }
  } catch {
    /* A malformed body belongs to the existing request/error path. */
  }
  return 'graphql.request';
}
