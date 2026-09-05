// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Operation documents are imported as module-scope constants, so the same
// object reference is reused across every execute()/subscribe() call. Cache
// the parsed name per object to avoid re-running the regex on the hot path.
const operationNameCache = new WeakMap<{ query: string }, string>();

export function getOperationName(operation: { query: string }, type: 'mutation' | 'query' | 'subscription'): string {
  const cached = operationNameCache.get(operation);
  if (cached) return cached;
  const pattern = type === 'subscription' ? /subscription\s+(\w+)/ : /(?:mutation|query)\s+(\w+)/;
  const match = operation.query.match(pattern);
  const name = match ? match[1] : 'unknown';
  operationNameCache.set(operation, name);
  return name;
}
