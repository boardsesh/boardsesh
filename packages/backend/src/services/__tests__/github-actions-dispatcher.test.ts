import { generateKeyPairSync } from 'node:crypto';

import { decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { createGitHubActionsDispatcher } from '../github-actions-dispatcher';

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
  return body;
}

describe('GitHub Actions dispatcher', () => {
  it('mints a scoped installation token and dispatches the fixed workflow on main', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({ url, init });
      if (url.endsWith('/installation')) return response({ id: 42 });
      if (url.endsWith('/access_tokens')) return response({ token: 'installation-token' }, 201);
      return response(null, 204);
    });
    const dispatcher = createGitHubActionsDispatcher(
      { appId: '1234', privateKey: privateKeyPem, owner: 'boardsesh', repository: 'boardsesh' },
      fetchImplementation,
      () => new Date('2026-09-03T01:00:00.000Z'),
    );

    await dispatcher.dispatchDiscordIssueWorkflow({
      channelId: '500000000000000001',
      triggerMessageId: '600000000000000001',
    });

    expect(requests).toHaveLength(3);
    const appAuthorization = new Headers(requests[0]?.init?.headers).get('Authorization')!;
    const appJwt = appAuthorization.replace('Bearer ', '');
    expect(decodeProtectedHeader(appJwt).alg).toBe('RS256');
    const verified = await jwtVerify(appJwt, publicKey, { issuer: '1234' });
    expect(verified.payload.iss).toBe('1234');

    expect(JSON.parse(requestBodyText(requests[1]?.init?.body))).toEqual({
      repositories: ['boardsesh'],
      permissions: { actions: 'write' },
    });
    expect(requests[2]?.url).toContain('/actions/workflows/discord-feedback-issues.yml/dispatches');
    expect(new Headers(requests[2]?.init?.headers).get('Authorization')).toBe('Bearer installation-token');
    expect(JSON.parse(requestBodyText(requests[2]?.init?.body))).toEqual({
      ref: 'main',
      inputs: {
        channel_id: '500000000000000001',
        trigger_message_id: '600000000000000001',
      },
    });
  });

  it('does not request an installation token after a failed lookup', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImplementation = vi.fn(async () => response({ message: 'Not Found' }, 404));
    const dispatcher = createGitHubActionsDispatcher(
      {
        appId: '1234',
        privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        owner: 'boardsesh',
        repository: 'boardsesh',
      },
      fetchImplementation,
    );
    await expect(
      dispatcher.dispatchDiscordIssueWorkflow({ channelId: 'channel', triggerMessageId: 'message' }),
    ).rejects.toThrow(/installation lookup failed/);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
