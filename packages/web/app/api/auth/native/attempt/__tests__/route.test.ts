import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { NATIVE_OAUTH_ATTEMPT_COOKIE, verifyNativeOAuthAttempt } from '@/app/lib/auth/native-oauth-transfer';

beforeEach(() => vi.stubEnv('NEXTAUTH_SECRET', 'native-attempt-test-secret'));
afterEach(() => vi.unstubAllEnvs());

describe('native browser attempt', () => {
  it('sets a signed HttpOnly marker in the browser origin', async () => {
    const attemptId = 'a'.repeat(32);
    const response = await POST(
      new NextRequest('https://www.boardsesh.com/api/auth/native/attempt', {
        method: 'POST',
        headers: { Origin: 'https://www.boardsesh.com' },
        body: JSON.stringify({ provider: 'apple', attemptId }),
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    expect(verifyNativeOAuthAttempt(response.cookies.get(NATIVE_OAUTH_ATTEMPT_COOKIE)?.value)).toMatchObject({
      provider: 'apple',
      attemptId,
    });
  });

  it.each([
    { origin: 'https://other.example', provider: 'apple', attemptId: 'a'.repeat(32), status: 403 },
    { origin: 'https://www.boardsesh.com', provider: 'facebook', attemptId: 'a'.repeat(32), status: 400 },
    { origin: 'https://www.boardsesh.com', provider: 'apple', attemptId: 'bad', status: 400 },
  ])('rejects foreign origins and unsupported markers', async ({ origin, provider, attemptId, status }) => {
    const response = await POST(
      new NextRequest('https://www.boardsesh.com/api/auth/native/attempt', {
        method: 'POST',
        headers: { Origin: origin },
        body: JSON.stringify({ provider, attemptId }),
      }),
    );
    expect(response.status).toBe(status);
    expect(response.cookies.get(NATIVE_OAUTH_ATTEMPT_COOKIE)).toBeUndefined();
  });
});
