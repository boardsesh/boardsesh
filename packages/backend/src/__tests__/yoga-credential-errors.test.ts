import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AuthAdmissionUnavailableError, AuthCredentialRefusedError } from '../auth/human-admission';

const validateToken = vi.hoisted(() => vi.fn());
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  validateToken,
}));

import { createYogaInstance } from '../graphql/yoga';

async function requestWithBearer() {
  const response = await createYogaInstance().fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer header.payload.signature' },
    body: JSON.stringify({ query: '{ __typename }' }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { errors?: { extensions?: { code?: string } }[] },
  };
}

/**
 * A 401 signs every shipped app out, so GraphQL HTTP may answer it only for a
 * credential admission refused. Anything else the validator throws must not
 * become a 401, or a future bug would sign every climber out at once.
 */
describe('GraphQL HTTP answers to what the credential validator throws', () => {
  beforeEach(() => {
    validateToken.mockReset();
  });

  it('answers a refused credential 401 UNAUTHENTICATED, asking the validator to throw on refusal', async () => {
    validateToken.mockRejectedValue(new AuthCredentialRefusedError());
    expect(await requestWithBearer()).toEqual({
      status: 401,
      body: { errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }] },
    });
    expect(validateToken).toHaveBeenCalledWith('header.payload.signature', { throwOnRefusal: true });
  });

  it('answers an admission outage 503, never 401', async () => {
    validateToken.mockRejectedValue(new AuthAdmissionUnavailableError());
    const response = await requestWithBearer();
    expect(response.status).toBe(503);
    expect(response.body.errors?.[0]?.extensions?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it.each([
    ['an Error', new Error('a future bug in a validator')],
    ['a TypeError', new TypeError('Cannot read properties of undefined')],
    [
      'an Error named like the refusal',
      Object.assign(new Error('Authentication is required'), { name: 'AuthCredentialRefusedError' }),
    ],
  ])('never answers 401 when the validator throws %s', async (_label, thrown) => {
    validateToken.mockRejectedValue(thrown);
    const response = await requestWithBearer();
    expect(response.status).not.toBe(401);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.errors?.map((error) => error.extensions?.code)).not.toContain('UNAUTHENTICATED');
  });
});
