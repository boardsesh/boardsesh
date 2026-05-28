export function getOperationName(operation: { query: string }, type: 'mutation' | 'query' | 'subscription'): string {
  const pattern = type === 'subscription' ? /subscription\s+(\w+)/ : /(?:mutation|query)\s+(\w+)/;
  const match = operation.query.match(pattern);
  return match ? match[1] : 'unknown';
}
