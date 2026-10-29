import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProjectNewsUnsubscribeUrl,
  createProjectNewsUnsubscribeToken,
  isProjectNewsUnsubscribeConfigured,
  PROJECT_NEWS_UNSUBSCRIBE_PATH,
  PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV,
  PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS,
  verifyProjectNewsUnsubscribeToken,
} from '../project-news-unsubscribe-token';

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
const OTHER_SECRET = 'another-secret-that-is-at-least-thirty-two-characters';
const NOW = Date.parse('2026-12-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const originalSecret = process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
const originalBackendUrl = process.env.BACKEND_PUBLIC_URL;

beforeEach(() => {
  process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
  else process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = originalSecret;
  if (originalBackendUrl === undefined) delete process.env.BACKEND_PUBLIC_URL;
  else process.env.BACKEND_PUBLIC_URL = originalBackendUrl;
});

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('project news unsubscribe tokens', () => {
  it('round-trips the user id while the token is fresh', () => {
    const token = createProjectNewsUnsubscribeToken('user-1', NOW);
    expect(verifyProjectNewsUnsubscribeToken(token, NOW)).toEqual({ ok: true, userId: 'user-1' });
    expect(verifyProjectNewsUnsubscribeToken(token, NOW + 364 * DAY_MS)).toEqual({ ok: true, userId: 'user-1' });
  });

  it('refuses an expired token even though its signature is good', () => {
    const token = createProjectNewsUnsubscribeToken('user-1', NOW);
    const expiry = NOW + PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS * 1000;
    expect(verifyProjectNewsUnsubscribeToken(token, expiry)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyProjectNewsUnsubscribeToken(token, expiry + DAY_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token whose payload was edited to name another account', () => {
    const token = createProjectNewsUnsubscribeToken('user-1', NOW);
    const [, signature] = token.split('.');
    const forgedPayload = encode({ p: 'project-news-unsubscribe', u: 'user-2', iat: NOW / 1000, exp: NOW / 1000 + 60 });
    expect(verifyProjectNewsUnsubscribeToken(`${forgedPayload}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token signed with a different secret', () => {
    process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = OTHER_SECRET;
    const token = createProjectNewsUnsubscribeToken('user-1', NOW);
    process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = SECRET;
    expect(verifyProjectNewsUnsubscribeToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([null, undefined, '', 'no-dot', 'a.b.c', '.sig', 'payload.', 'x'.repeat(600)])(
    'calls %j malformed or unsigned',
    (token) => {
      const result = verifyProjectNewsUnsubscribeToken(token, NOW);
      expect(result.ok).toBe(false);
    },
  );

  it('refuses a token that claims a longer life than a minted one can have', async () => {
    // The module never mints this, so sign it by hand with the same derived key.
    const crypto = await import('node:crypto');
    const key = Buffer.from(crypto.hkdfSync('sha256', SECRET, '', 'boardsesh-project-news-unsubscribe-v1', 32));
    const payload = encode({
      p: 'project-news-unsubscribe',
      u: 'user-1',
      iat: NOW / 1000,
      exp: NOW / 1000 + PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS * 10,
    });
    const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
    expect(verifyProjectNewsUnsubscribeToken(`${payload}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a signed token minted for another purpose', async () => {
    const crypto = await import('node:crypto');
    const key = Buffer.from(crypto.hkdfSync('sha256', SECRET, '', 'boardsesh-project-news-unsubscribe-v1', 32));
    const payload = encode({ p: 'something-else', u: 'user-1', iat: NOW / 1000, exp: NOW / 1000 + 60 });
    const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
    expect(verifyProjectNewsUnsubscribeToken(`${payload}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports not configured, and refuses to mint, without a long enough secret', () => {
    delete process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
    expect(isProjectNewsUnsubscribeConfigured()).toBe(false);
    expect(verifyProjectNewsUnsubscribeToken('a.b', NOW)).toEqual({ ok: false, reason: 'not_configured' });
    expect(() => createProjectNewsUnsubscribeToken('user-1', NOW)).toThrow(PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV);
    process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = 'too-short';
    expect(isProjectNewsUnsubscribeConfigured()).toBe(false);
  });

  it('builds the link on the backend origin with the token URL-encoded', () => {
    process.env.BACKEND_PUBLIC_URL = 'https://ws.example.test/';
    const url = new URL(buildProjectNewsUnsubscribeUrl('user-1', NOW));
    expect(`${url.origin}${url.pathname}`).toBe(`https://ws.example.test${PROJECT_NEWS_UNSUBSCRIBE_PATH}`);
    expect(verifyProjectNewsUnsubscribeToken(url.searchParams.get('token'), NOW)).toEqual({
      ok: true,
      userId: 'user-1',
    });
  });
});
