/**
 * The App-auth path replaced a personal access token, so these tests exist to
 * pin two things: the token GitHub is asked for is a well-formed one, and every
 * way this can fail returns undefined instead of throwing. A throw here would
 * surface as a failed bug report or a lost QA verdict, which is exactly the
 * behaviour the PAT version was careful to avoid.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { getInstallationAccessToken, normalizePrivateKey, resetGithubAppAuthCache } from '../github-app-auth';

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const REPO = 'boardsesh/boardsesh';
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

const pkcs8 = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

const pkcs1 = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

type FetchCall = { url: string; init: RequestInit | undefined };

/** Records every call and answers the two endpoints the mint walks through. */
function stubGitHub(options: { token?: string; expiresAt?: string; failOn?: 'installation' | 'token' } = {}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    calls.push({ url, init });

    if (url.endsWith('/installation')) {
      if (options.failOn === 'installation') return new Response('nope', { status: 404 });
      return Response.json({ id: 987654 });
    }
    if (url.includes('/access_tokens')) {
      if (options.failOn === 'token') return new Response('nope', { status: 401 });
      return Response.json({
        token: options.token ?? 'ghs_installation_token',
        expires_at: options.expiresAt ?? new Date(NOW + 60 * 60 * 1000).toISOString(),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  resetGithubAppAuthCache();
  vi.stubEnv('GITHUB_APP_ID', '4098323');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', pkcs8);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('normalizePrivateKey', () => {
  it('passes a real multi-line PEM through', () => {
    expect(normalizePrivateKey(pkcs8)).toContain('-----BEGIN');
  });

  it('unescapes a one-line PEM whose newlines became literal backslash-n', () => {
    const escaped = pkcs8.replace(/\n/g, '\\n');
    expect(normalizePrivateKey(escaped)).toBe(pkcs8.trim());
  });

  it('decodes base64 of a PEM', () => {
    expect(normalizePrivateKey(Buffer.from(pkcs8).toString('base64'))).toContain('-----BEGIN');
  });

  it('returns null for something that is not a key at all', () => {
    expect(normalizePrivateKey('hunter2')).toBeNull();
    expect(normalizePrivateKey('   ')).toBeNull();
  });

  it('refuses a passphrase-protected key instead of mangling it', () => {
    // There is nowhere to supply a passphrase, and the PKCS#1 rewrap would
    // otherwise wrap the encrypted body into DER that fails far from here.
    const pkcs1Encrypted = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      'c29tZSBlbmNyeXB0ZWQgYnl0ZXM=',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(normalizePrivateKey(pkcs1Encrypted)).toBeNull();
    expect(normalizePrivateKey(Buffer.from(pkcs1Encrypted).toString('base64'))).toBeNull();
    expect(
      normalizePrivateKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----'),
    ).toBeNull();
  });
});

describe('getInstallationAccessToken', () => {
  it('signs an RS256 JWT whose claims GitHub will accept', async () => {
    const { calls } = stubGitHub();
    await getInstallationAccessToken(REPO, NOW);

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    const jwt = (headers ?? {}).Authorization.replace('Bearer ', '');
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');

    const claims = decodeJwt(jwt);
    const nowSeconds = Math.floor(NOW / 1000);
    expect(claims.iss).toBe('4098323');
    // Back-dated, so GitHub's clock being slightly behind ours cannot reject it.
    expect(claims.iat).toBeLessThan(nowSeconds);
    // GitHub refuses anything claiming more than 10 minutes.
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600);
  });

  it('returns the installation token and asks the right endpoints in order', async () => {
    const { calls } = stubGitHub({ token: 'ghs_abc' });
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBe('ghs_abc');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/boardsesh/boardsesh/installation');
    expect(calls[1]?.url).toBe('https://api.github.com/app/installations/987654/access_tokens');
    expect(calls[1]?.init?.method).toBe('POST');
  });

  it('accepts a PKCS#1 key, which is what GitHub hands out', async () => {
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', pkcs1);
    stubGitHub();
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBe('ghs_installation_token');
  });

  it('serves the cached token without touching GitHub again', async () => {
    const { fetchMock } = stubGitHub();
    await getInstallationAccessToken(REPO, NOW);
    const callsAfterFirst = fetchMock.mock.calls.length;

    await getInstallationAccessToken(REPO, NOW + 30 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-mints inside the renewal margin rather than handing out a token about to expire', async () => {
    const { fetchMock } = stubGitHub();
    await getInstallationAccessToken(REPO, NOW);
    const callsAfterFirst = fetchMock.mock.calls.length;

    // 57 minutes in: four minutes of life left, inside the five-minute margin.
    await getInstallationAccessToken(REPO, NOW + 57 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('collapses concurrent callers onto a single mint', async () => {
    const { fetchMock } = stubGitHub();
    const tokens = await Promise.all([
      getInstallationAccessToken(REPO, NOW),
      getInstallationAccessToken(REPO, NOW),
      getInstallationAccessToken(REPO, NOW),
    ]);
    expect(tokens).toEqual(['ghs_installation_token', 'ghs_installation_token', 'ghs_installation_token']);
    // One installation lookup + one token mint, not three of each.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('returns undefined when the App is not configured', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    const { fetchMock } = stubGitHub();
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the private key is not a key', async () => {
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'not-a-pem');
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBeUndefined();
  });

  it('returns undefined when the App is not installed on the repo', async () => {
    stubGitHub({ failOn: 'installation' });
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBeUndefined();
  });

  it('returns undefined when GitHub refuses the token mint', async () => {
    stubGitHub({ failOn: 'token' });
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBeUndefined();
  });

  it('retries the installation lookup after a failure instead of pinning a stale id', async () => {
    stubGitHub({ failOn: 'installation' });
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBeUndefined();

    const { calls } = stubGitHub();
    await expect(getInstallationAccessToken(REPO, NOW)).resolves.toBe('ghs_installation_token');
    expect(calls[0]?.url).toContain('/installation');
  });

  it('falls back to a one-hour lifetime when the expiry is unparseable', async () => {
    const { fetchMock } = stubGitHub({ expiresAt: 'not a date' });
    await getInstallationAccessToken(REPO, NOW);
    const callsAfterFirst = fetchMock.mock.calls.length;

    await getInstallationAccessToken(REPO, NOW + 30 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not serve one repo's token for another", async () => {
    // A token is minted per installation, so a shared cache would hand the
    // wrong credential over and 404 every write from a cache that looks warm.
    const { calls } = stubGitHub({ token: 'ghs_first' });
    await expect(getInstallationAccessToken('boardsesh/boardsesh', NOW)).resolves.toBe('ghs_first');

    const callsAfterFirst = calls.length;
    await expect(getInstallationAccessToken('someone/fork', NOW)).resolves.toBe('ghs_first');
    // A second repo means a second installation lookup, not a cache hit.
    expect(calls.slice(callsAfterFirst).some((call) => call.url.includes('/repos/someone/fork/installation'))).toBe(
      true,
    );
  });

  it('rejects a repo that is not owner/name without calling GitHub', async () => {
    const { fetchMock } = stubGitHub();
    await expect(getInstallationAccessToken('boardsesh', NOW)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
