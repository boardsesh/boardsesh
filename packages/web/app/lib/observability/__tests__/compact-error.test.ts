import { describe, expect, it } from 'vite-plus/test';
import { compactErrorMessage } from '../compact-error';

describe('compactErrorMessage', () => {
  it('extracts the resolver message from a graphql-request ClientError shape', () => {
    // graphql-request's ClientError.message embeds the whole request document
    // and variables plus the whole response body; the plain `.message` is not
    // safe to log or return.
    const clientError = Object.assign(
      new Error(
        'GraphQL Error (Code: 400): {"response":{"errors":[{"message":"You already have a board with this configuration"}]},"request":{"query":"query SimilarClimbs($input: SimilarClimbsInput!) { similarClimbs(input: $input) { uuid name } }","variables":{"input":{"boardType":"kilter","layoutId":8,"climbUuid":"climb-1","angle":40,"threshold":0.5,"limit":10}}}}',
      ),
      {
        response: {
          errors: [{ message: 'You already have a board with this configuration' }],
        },
      },
    );

    const result = compactErrorMessage(clientError);

    expect(result).toBe('You already have a board with this configuration');
    expect(result).not.toContain('similarClimbs');
    expect(result).not.toContain('boardType');
  });

  it('unwraps a DrizzleQueryError to its cause, dropping the embedded SQL', () => {
    const postgresCause = Object.assign(new Error('CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' });
    const drizzleError = Object.assign(
      new Error(
        'Failed query: SELECT "id", "email", "password_hash" FROM "users" WHERE "users"."email" = $1 params: test@boardsesh.com',
      ),
      { name: 'DrizzleQueryError', cause: postgresCause },
    );

    const result = compactErrorMessage(drizzleError);

    expect(result).toBe('DrizzleQueryError: CONNECT_TIMEOUT');
    expect(result).not.toContain('SELECT');
    expect(result).not.toContain('test@boardsesh.com');
  });

  it('formats a plain Error as name: message', () => {
    expect(compactErrorMessage(new Error('network down'))).toBe('Error: network down');
  });

  it('formats a plain Error subclass using its own name', () => {
    class TimeoutError extends Error {
      name = 'TimeoutError';
    }
    expect(compactErrorMessage(new TimeoutError('deadline exceeded'))).toBe('TimeoutError: deadline exceeded');
  });

  it('stringifies a non-Error throw', () => {
    expect(compactErrorMessage('a raw string throw')).toBe('a raw string throw');
    expect(compactErrorMessage(42)).toBe('42');
    expect(compactErrorMessage(null)).toBe('null');
  });

  it('truncates to maxLength', () => {
    const longMessage = new Error('x'.repeat(500));
    const result = compactErrorMessage(longMessage, 50);

    expect(result.length).toBe(50);
    expect(result).toBe(`Error: ${'x'.repeat(43)}`);
  });

  it('truncates using the default maxLength of 200 when none is passed', () => {
    const longMessage = new Error('y'.repeat(500));
    const result = compactErrorMessage(longMessage);

    expect(result.length).toBe(200);
  });
});
