import { describe, expect, it } from 'vite-plus/test';
import { classifyConsoleError } from '../console-errors';

function graphQLError(extensions: Record<string, unknown>, message = 'Server text') {
  return { response: { errors: [{ message, extensions }] } };
}

describe('classifyConsoleError', () => {
  it.each([
    [{ code: 'NOT_FOUND' }, 'not-available'],
    [{ code: 'NOT_FOUND', reason: 'NOT_FOUND' }, 'gone'],
    [{ code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 60 }, 'paused'],
    [{ code: 'SERVICE_UNAVAILABLE', reason: 'BUSY' }, 'busy'],
    [{ code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' }, 'not-allowlisted'],
    [{ code: 'FORBIDDEN', reason: 'EMAIL_NOT_VERIFIED' }, 'email-not-verified'],
    [{ code: 'FORBIDDEN', reason: 'SUSPENDED' }, 'suspended'],
    [{ code: 'RATE_LIMITED', retryAfterSeconds: 12 }, 'rate-limited'],
    [{ code: 'INTERNAL_SERVER_ERROR' }, 'failed'],
  ])('reads %j as %s, by code and reason', (extensions, kind) => {
    expect(classifyConsoleError(graphQLError(extensions)).kind).toBe(kind);
  });

  it("shows the server's own refusal for a bad field, which names the rule", () => {
    expect(
      classifyConsoleError(
        graphQLError({ code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' }, 'A redirect URI cannot have a fragment (#).'),
      ),
    ).toEqual({ kind: 'invalid-input', message: 'A redirect URI cannot have a fragment (#).' });
  });

  it('calls a network failure or anything without a GraphQL error a plain failure', () => {
    expect(classifyConsoleError(new TypeError('Failed to fetch')).kind).toBe('failed');
    expect(classifyConsoleError({ response: { errors: [] } }).kind).toBe('failed');
    expect(classifyConsoleError(null).kind).toBe('failed');
  });
});
