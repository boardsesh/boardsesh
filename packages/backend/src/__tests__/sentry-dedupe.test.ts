import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { markErrorReported, wasErrorReported } from '../utils/sentry-dedupe';

describe('sentry-dedupe', () => {
  it('reports false for an unmarked error', () => {
    expect(wasErrorReported(new Error('boom'))).toBe(false);
  });

  it('reports true after marking', () => {
    const err = new Error('boom');
    markErrorReported(err);
    expect(wasErrorReported(err)).toBe(true);
  });

  it('sees a mark on the wrapped originalError (how graphql-js surfaces resolver throws)', () => {
    const original = new Error('boom');
    markErrorReported(original);
    const wrapped = new GraphQLError('masked', { originalError: original });
    expect(wasErrorReported(wrapped)).toBe(true);
  });

  it('reports false for a wrapper whose originalError is unmarked', () => {
    const wrapped = new GraphQLError('masked', { originalError: new Error('boom') });
    expect(wasErrorReported(wrapped)).toBe(false);
  });

  it('tolerates non-object inputs', () => {
    expect(wasErrorReported(undefined)).toBe(false);
    expect(wasErrorReported('nope')).toBe(false);
    expect(() => markErrorReported('nope')).not.toThrow();
  });
});
