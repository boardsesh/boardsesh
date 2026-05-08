import { describe, expect, it } from 'vite-plus/test';
import { normalizeGraphQLWsError } from '../graphql-client';

describe('normalizeGraphQLWsError', () => {
  it('preserves Error instances', () => {
    const error = new Error('Already useful');
    expect(normalizeGraphQLWsError(error, 'Context')).toBe(error);
  });

  it('uses message fields from GraphQL-style error objects', () => {
    const error = normalizeGraphQLWsError({ message: 'Session expired' }, 'Queue subscription failed');
    expect(error.message).toBe('Queue subscription failed: Session expired');
    expect(error.transientTransportError).toBeUndefined();
  });

  it('turns opaque websocket events into useful transient errors', () => {
    const error = normalizeGraphQLWsError({ type: 'error', target: { readyState: 3 } }, 'Queue subscription failed');
    expect(error.message).toContain('Queue subscription failed: WebSocket error event');
    expect(error.message).toContain('"type":"error"');
    expect(error.transientTransportError).toBe(true);
  });
});
