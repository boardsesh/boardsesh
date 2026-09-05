// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';
import {
  AuroraRequestError,
  createAuroraNetworkError,
  createAuroraResponseError,
  createAuroraTimeoutError,
  isTransientAuroraError,
  isTransientSharedSyncAuroraError,
} from './errors';

describe('AuroraRequestError', () => {
  it('treats generic Aurora HTTP failures as transient', async () => {
    const response = new Response(JSON.stringify({ error: 'upstream unavailable' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await createAuroraResponseError(response, 'https://decoyboardapp.com/sync');

    expect(error).toBeInstanceOf(AuroraRequestError);
    expect(error.code).toBe('http');
    expect(error.status).toBe(503);
    expect(isTransientAuroraError(error)).toBe(true);
  });

  it('treats Aurora rate limiting as transient', async () => {
    const response = new Response('slow down', {
      status: 429,
      statusText: 'Too Many Requests',
    });

    const error = await createAuroraResponseError(response, 'https://decoyboardapp.com/sessions');

    expect(error.code).toBe('rate_limited');
    expect(isTransientAuroraError(error)).toBe(true);
  });

  it('treats invalid credentials as a hard error', async () => {
    const response = new Response(JSON.stringify({ error: 'invalid credentials' }), {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await createAuroraResponseError(response, 'https://decoyboardapp.com/sessions', {
      invalidCredentialsMessage: 'Invalid username or password',
    });

    expect(error.code).toBe('invalid_credentials');
    expect(error.message).toBe('Invalid username or password');
    expect(isTransientAuroraError(error)).toBe(false);
  });

  it('treats timeout and network failures as transient', () => {
    expect(isTransientAuroraError(createAuroraTimeoutError('https://decoyboardapp.com/sync'))).toBe(true);
    expect(isTransientAuroraError(createAuroraNetworkError('https://decoyboardapp.com/sync'))).toBe(true);
  });
});

describe('isTransientSharedSyncAuroraError', () => {
  it.each([
    { code: 'timeout', status: undefined, expected: true },
    { code: 'network', status: undefined, expected: true },
    { code: 'rate_limited', status: undefined, expected: true },
    { code: 'http', status: 429, expected: true },
    { code: 'http', status: 499, expected: false },
    { code: 'http', status: 500, expected: true },
    { code: 'http', status: 599, expected: true },
    { code: 'http', status: 600, expected: false },
    { code: 'http', status: undefined, expected: false },
    { code: 'invalid_credentials', status: 422, expected: false },
    { code: 'invalid_response', status: undefined, expected: false },
  ] as const)('classifies $code with HTTP $status as transient=$expected', ({ code, status, expected }) => {
    const error = new AuroraRequestError({
      code,
      message: `${code} failure`,
      status,
    });

    expect(isTransientSharedSyncAuroraError(error)).toBe(expected);
  });

  it('rejects arbitrary errors and Aurora-shaped plain objects', () => {
    expect(isTransientSharedSyncAuroraError(new Error('database unavailable'))).toBe(false);
    expect(isTransientSharedSyncAuroraError({ code: 'timeout', transient: true })).toBe(false);
  });
});
