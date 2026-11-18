import { createHash, randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, assertCachedCredentials, login, logout, recoverCredentialState, type AuthOptions } from '../auth';
import { readCredentials, writeCredentials } from '../credentials';
import * as credentialsModule from '../credentials';
import { ensurePrivateDirectory, withProfileLock, type ProfileLock } from '../profile-lock';
import { API_ORIGIN, ISSUER, RESOURCE, SCOPES, McpError, type Profile, type ProfileStore } from '../types';
import { createPrivateWindowsFile } from '../windows-security';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemoryStore implements ProfileStore {
  profile: Profile | undefined;
  resetCount = 0;
  getProfile() {
    return this.profile;
  }
  setProfile(profile: Profile) {
    this.profile = profile;
  }
  activateProfile(profile: Profile) {
    this.profile = profile;
    this.resetSync();
  }
  assertProfile(generation: string) {
    if (!this.profile || this.profile.generation !== generation || this.profile.authStatus !== 'connected') {
      throw new McpError('reconnect_required', 'Reconnect');
    }
    return this.profile;
  }
  resetSync() {
    this.resetCount++;
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'boardsesh-mcp-auth-'));
  directories.push(directory);
  const dataDir = join(directory, 'private-profile');
  await ensurePrivateDirectory(dataDir);
  const store = new MemoryStore();
  const profile: Profile = {
    issuer: ISSUER,
    clientId: 'public-client',
    subject: 'usr_climber',
    accountId: 'account-a',
    generation: randomUUID(),
    authStatus: 'connected',
    scopes: [...SCOPES],
  };
  store.setProfile(profile);
  return { dataDir, store, profile };
}

async function seed(options: AuthOptions, profile: Profile, refreshPending = false) {
  await writeCredentials(
    options.dataDir,
    {
      version: 1,
      issuer: ISSUER,
      clientId: profile.clientId,
      generation: profile.generation,
      accountId: profile.accountId,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      refreshPending,
    },
    options.guard,
  );
}

function json(payload: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json');
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('OAuth API credentials', () => {
  it('blocks an unresolved rotation after its lock releases even when the owner process survives', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockResolvedValueOnce(
          json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' }),
        );
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      const originalWrite = credentialsModule.writeCredentials;
      let writes = 0;
      const write = vi.spyOn(credentialsModule, 'writeCredentials').mockImplementation(async (...argumentsList) => {
        writes++;
        if (writes === 2) throw new Error('Credential replacement could not be persisted');
        return originalWrite(...argumentsList);
      });
      const persistProfile = vi.spyOn(store, 'setProfile').mockImplementation(() => {
        throw new Error('Profile database full');
      });
      try {
        await expect(new ApiClient(options).request(profile, '/v1/me')).rejects.toMatchObject({
          code: 'reconnect_required',
        });
        expect(await readCredentials(dataDir)).toMatchObject({ refreshPending: true, refreshOwnerPid: process.pid });
      } finally {
        write.mockRestore();
        persistProfile.mockRestore();
      }
    });
    expect(store.getProfile()?.authStatus).toBe('connected');
    await expect(assertCachedCredentials({ dataDir, store })).rejects.toMatchObject({ code: 'reconnect_required' });
  });

  it('keeps cached reads available while an authorized refresh holds the profile lock', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      let refreshStarted!: () => void;
      let finishRefresh!: (response: Response) => void;
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      const pendingResponse = new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
      let apiCalls = 0;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (requestUrl(input).endsWith('/oauth2/token')) {
          refreshStarted();
          return pendingResponse;
        }
        apiCalls++;
        return apiCalls === 1 ? json({ error: 'invalid_token' }, 401) : json({ id: profile.subject });
      });
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      const request = new ApiClient(options).request(profile, '/v1/me');
      await started;
      try {
        expect(await readCredentials(dataDir)).toMatchObject({ refreshPending: true, refreshOwnerPid: process.pid });
        expect(await assertCachedCredentials({ dataDir, store })).toEqual(profile);
      } finally {
        finishRefresh(json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' }));
      }
      await request;
      expect(await readCredentials(dataDir)).not.toHaveProperty('refreshOwnerPid');
    });
  });

  it.each([undefined, 2_147_483_647])(
    'blocks cached reads for an abandoned refresh owner %s without mutating state',
    async (refreshOwnerPid) => {
      const { dataDir, store, profile } = await fixture();
      await withProfileLock(dataDir, async (guard) => {
        const options = { dataDir, store, guard };
        await seed(options, profile);
        const credentials = await readCredentials(dataDir);
        if (!credentials) throw new Error('Missing fixture credentials');
        await writeCredentials(dataDir, { ...credentials, refreshPending: true, refreshOwnerPid }, guard);
      });
      await expect(assertCachedCredentials({ dataDir, store })).rejects.toMatchObject({ code: 'reconnect_required' });
      expect(store.getProfile()?.authStatus).toBe('connected');
    },
  );

  it('rechecks profile identity after awaiting the atomic credential read', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => seed({ dataDir, store, guard }, profile));
    const validate = assertCachedCredentials({ dataDir, store });
    store.setProfile({ ...profile, generation: randomUUID(), subject: 'different-climber' });
    await expect(validate).rejects.toMatchObject({ code: 'reconnect_required' });
  });

  it('rechecks persisted revocation after awaiting credentials', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => seed({ dataDir, store, guard }, profile));
    const validate = assertCachedCredentials({ dataDir, store });
    store.setProfile({ ...profile, authStatus: 'reconnect_required' });
    await expect(validate).rejects.toMatchObject({ code: 'reconnect_required' });
  });
  it('rotates exactly once after expiry and stores the new pair before retrying', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const requests: string[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        requests.push(requestUrl(input));
        expect(init?.redirect).toBe('error');
        if (requestUrl(input).endsWith('/oauth2/token')) {
          expect(await readCredentials(dataDir)).toMatchObject({ refreshPending: true });
          const body = init?.body as URLSearchParams;
          expect(body.get('resource')).toBe(RESOURCE);
          expect(body.get('client_secret')).toBeNull();
          return json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' });
        }
        if (new Headers(init?.headers).get('authorization') === 'Bearer old-access')
          return json({ error: 'invalid_token' }, 401);
        expect(await readCredentials(dataDir)).toMatchObject({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          refreshPending: false,
        });
        return json({ id: 'usr_climber' });
      });
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      expect(await new ApiClient(options).request(profile, '/v1/me')).toEqual({ id: 'usr_climber' });
      expect(requests).toEqual([`${API_ORIGIN}/v1/me`, `${ISSUER}/oauth2/token`, `${API_ORIGIN}/v1/me`]);
    });
  });

  it.each(['invalid_grant', 'lost-response', 'malformed-success', 'server-error', 'gateway-error'])(
    'blocks local reads after %s during refresh without replay',
    async (failure) => {
      const { dataDir, store, profile } = await fixture();
      await withProfileLock(dataDir, async (guard) => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
          if (requestUrl(input).endsWith('/v1/me')) return json({ error: 'invalid_token' }, 401);
          if (failure === 'lost-response') throw new Error('secret old-refresh must not leak');
          if (failure === 'malformed-success') return json({ access_token: 'incomplete' });
          if (failure === 'server-error') return json({ error: 'server_error' }, 503);
          if (failure === 'gateway-error') return json({ error: 'bad_gateway' }, 502);
          return json({ error: 'invalid_grant' }, 400);
        });
        const options = { dataDir, store, guard, fetch: fetcher };
        await seed(options, profile);
        const client = new ApiClient(options);
        await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'reconnect_required' });
        expect(store.getProfile()?.authStatus).toBe('reconnect_required');
        await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'reconnect_required' });
        expect(fetcher).toHaveBeenCalledTimes(2);
      });
    },
  );

  it.each([
    { code: 'ENOTFOUND' },
    { code: 'EAI_AGAIN' },
    { code: 'ECONNREFUSED', syscall: 'connect' },
    { code: 'ETIMEDOUT', syscall: 'connect' },
    { code: 'UND_ERR_CONNECT_TIMEOUT' },
    new AggregateError([{ code: 'ECONNREFUSED', syscall: 'connect' }, { code: 'ENOTFOUND' }]),
  ])('keeps a refresh token usable after a proven pre-send failure %j', async (cause) => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause }))
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockResolvedValueOnce(json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' }))
        .mockResolvedValueOnce(json({ id: 'usr_climber' }));
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      const client = new ApiClient(options);
      await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'network_unavailable' });
      expect(await readCredentials(dataDir)).toMatchObject({ refreshPending: false, refreshToken: 'old-refresh' });
      expect(await readCredentials(dataDir)).not.toHaveProperty('refreshOwnerPid');
      await expect(assertCachedCredentials({ dataDir, store })).resolves.toEqual(profile);
      await expect(client.request(profile, '/v1/me')).resolves.toEqual({ id: 'usr_climber' });
      const refreshCalls = fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/oauth2/token'));
      expect(refreshCalls).toHaveLength(2);
      expect(
        refreshCalls.map(([, request]) => (request?.body as URLSearchParams | undefined)?.get('refresh_token')),
      ).toEqual(['old-refresh', 'old-refresh']);
    });
  });

  it.each([
    { code: 'ECONNRESET' },
    { code: 'ETIMEDOUT', syscall: 'write' },
    { code: 'UND_ERR_HEADERS_TIMEOUT' },
    { code: 'UND_ERR_SOCKET' },
    { code: 'ECONNRESET', cause: { code: 'ENOTFOUND' } },
    new AggregateError([{ code: 'ENOTFOUND' }, { code: 'ECONNRESET' }]),
  ])('never retries a possibly sent refresh after %j', async (cause) => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause }));
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      const client = new ApiClient(options);
      await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'reconnect_required' });
      await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'reconnect_required' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('recovers an interrupted refresh before offline reads or further network activity', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi.fn<typeof fetch>();
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile, true);
      await recoverCredentialState(options);
      expect(store.getProfile()?.authStatus).toBe('reconnect_required');
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it('preserves offline authorization after network errors and explicit rate limits', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockResolvedValueOnce(json({ error: 'rate_limited' }, 429, { 'retry-after': '42' }));
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      const client = new ApiClient(options);
      await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ code: 'network_unavailable' });
      await expect(client.request(profile, '/v1/me')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 42 });
      expect(store.getProfile()?.authStatus).toBe('connected');
      expect(await readCredentials(dataDir)).toMatchObject({ refreshPending: false, refreshToken: 'old-refresh' });
    });
  });

  it('rejects a second 401 and prevents a stale profile borrowing another account credentials', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockResolvedValueOnce(json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' }))
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401));
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      await expect(new ApiClient(options).request(profile, '/v1/me')).rejects.toMatchObject({
        code: 'reconnect_required',
      });
      const next = {
        ...profile,
        generation: randomUUID(),
        subject: 'usr_someone_else',
        authStatus: 'connected' as const,
      };
      store.setProfile(next);
      await expect(new ApiClient(options).request(profile, '/v1/me')).rejects.toMatchObject({
        code: 'reconnect_required',
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  it('persists a narrowed scope grant before the retried API call completes', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
        .mockResolvedValueOnce(
          json({
            token_type: 'Bearer',
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'workouts:read offline_access',
          }),
        )
        .mockResolvedValueOnce(json({ id: 'usr_climber' }));
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      await new ApiClient(options).request(profile, '/v1/me');
      expect(store.getProfile()?.scopes).toEqual(['workouts:read', 'offline_access']);
    });
  });

  it('blocks cached access after a partial login writes credentials for another generation', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const options = { dataDir, store, guard };
      await seed(options, { ...profile, generation: randomUUID(), accountId: 'new-account' });
      await recoverCredentialState(options);
      expect(store.getProfile()).toMatchObject({ accountId: profile.accountId, authStatus: 'reconnect_required' });
    });
  });

  it('never sends tokens to an arbitrary host or first-party endpoint', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi.fn<typeof fetch>();
      const options = { dataDir, store, guard, fetch: fetcher };
      await seed(options, profile);
      for (const path of [
        'https://attacker.example/v1/me',
        '//attacker.example/v1/me',
        '/v1/../graphql',
        '/v1/connection',
      ]) {
        await expect(new ApiClient(options).request(profile, path)).rejects.toMatchObject({ code: 'invalid_request' });
      }
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it('locally logs out while offline, leaves no credentials and reports remote revocation uncertainty', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const options = { dataDir, store, guard, fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')) };
      await seed(options, profile);
      expect(await logout(options)).toEqual({ remoteRevoked: false });
      expect(store.getProfile()?.authStatus).toBe('logged_out');
      expect(await readCredentials(dataDir)).toBeUndefined();
    });
  });
});

describe('browser login', () => {
  it('accepts only the state-bound loopback callback and exchanges a public PKCE grant once', async () => {
    const { dataDir, store } = await fixture();
    let authorization: URL | undefined;
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const address = requestUrl(input);
        if (address.includes('.well-known'))
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/oauth2/authorize`,
            token_endpoint: `${ISSUER}/oauth2/token`,
            code_challenge_methods_supported: ['S256'],
          });
        if (address.endsWith('/oauth2/token')) {
          const body = init?.body as URLSearchParams;
          expect(body.get('client_secret')).toBeNull();
          expect(body.get('code')).toBe('one-use-code');
          expect(
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url'),
          ).toBe(authorization?.searchParams.get('code_challenge'));
          return json({
            token_type: 'Bearer',
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: SCOPES.join(' '),
          });
        }
        return json({ id: 'usr_new_climber' });
      });
      const connected = await login({
        dataDir,
        store,
        guard,
        clientId: 'registered-public-client',
        fetch: fetcher,
        onAuthorizationUrl: async (address) => {
          authorization = new URL(address);
          expect(authorization.searchParams.get('resource')).toBe(RESOURCE);
          const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
          expect(callback.hostname).toBe('127.0.0.1');
          callback.search = new URLSearchParams({ code: 'one-use-code', state: 'wrong', iss: ISSUER }).toString();
          const refused = await fetch(callback);
          expect(refused.status).toBe(400);
          await refused.text();
          callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
          const accepted = await fetch(callback);
          expect(accepted.status).toBe(200);
          await accepted.text();
          const replay = await fetch(callback);
          expect(replay.status).toBe(400);
          await replay.text();
        },
      });
      expect(connected).toMatchObject({
        subject: 'usr_new_climber',
        clientId: 'registered-public-client',
        authStatus: 'connected',
      });
      expect(await readCredentials(dataDir)).toMatchObject({
        generation: connected.generation,
        accessToken: 'new-access',
      });
      expect(store.resetCount).toBe(1);
      expect(connected.clientIdSource).toBe('override');
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  it('does not accept a callback with the wrong issuer and expires boundedly', async () => {
    const { dataDir, store } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          code_challenge_methods_supported: ['S256'],
        }),
      );
      await expect(
        login({
          dataDir,
          store,
          guard,
          clientId: 'public-client',
          fetch: fetcher,
          timeoutMs: 100,
          onAuthorizationUrl: async (address) => {
            const authorization = new URL(address);
            const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
            callback.search = new URLSearchParams({
              code: 'code',
              state: authorization.searchParams.get('state') ?? '',
              iss: 'https://attacker.example',
            }).toString();
            const refused = await fetch(callback);
            expect(refused.status).toBe(400);
            await refused.text();
          },
        }),
      ).rejects.toMatchObject({ code: 'authorization_timeout' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['identity-failure', 'identity-malformed', 'profile-change', 'revocation-offline', 'activation-failure'])(
    'revokes only the newly issued family after login cannot finish: %s',
    async (failure) => {
      const { dataDir, store, profile } = await fixture();
      await withProfileLock(dataDir, async (guard) => {
        await seed({ dataDir, store, guard }, profile);
        if (failure === 'activation-failure') {
          store.activateProfile = () => {
            throw new McpError('storage_unavailable', 'Profile transaction failed.');
          };
        }
        const revoked: URLSearchParams[] = [];
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          const address = requestUrl(input);
          if (address.includes('.well-known'))
            return json({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/oauth2/authorize`,
              token_endpoint: `${ISSUER}/oauth2/token`,
              code_challenge_methods_supported: ['S256'],
            });
          if (address.endsWith('/oauth2/token'))
            return json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh' });
          if (address.endsWith('/oauth2/revoke')) {
            revoked.push(init?.body as URLSearchParams);
            if (failure === 'revocation-offline') throw new Error('offline');
            return new Response(null, { status: 200 });
          }
          if (failure === 'profile-change') {
            store.setProfile({ ...profile, generation: randomUUID() });
            return json({ id: 'usr_new_climber' });
          }
          if (failure === 'activation-failure') return json({ id: 'usr_new_climber' });
          if (failure === 'identity-malformed') return json({ name: 'no ID' });
          return json({ error: 'temporarily_unavailable' }, 503);
        });
        await expect(
          login({
            dataDir,
            store,
            guard,
            clientId: 'new-client',
            fetch: fetcher,
            onAuthorizationUrl: async (address) => {
              const authorization = new URL(address);
              const callback = new URL(authorization.searchParams.get('redirect_uri')!);
              callback.search = new URLSearchParams({
                code: 'one-use-code',
                state: authorization.searchParams.get('state')!,
                iss: ISSUER,
              }).toString();
              await (await fetch(callback)).text();
            },
          }),
        ).rejects.toMatchObject({
          code:
            failure === 'profile-change'
              ? 'profile_changed'
              : failure === 'identity-malformed'
                ? 'invalid_response'
                : failure === 'activation-failure'
                  ? 'storage_unavailable'
                  : 'temporarily_unavailable',
        });
        expect(revoked.map((body) => Object.fromEntries(body))).toEqual([
          { token: 'new-refresh', token_type_hint: 'refresh_token', client_id: 'new-client' },
        ]);
        if (failure === 'activation-failure') {
          expect(await readCredentials(dataDir)).toMatchObject({ refreshToken: 'new-refresh' });
          expect(store.getProfile()).toEqual(profile);
          await expect(assertCachedCredentials({ dataDir, store })).rejects.toMatchObject({
            code: 'reconnect_required',
          });
        } else {
          expect(await readCredentials(dataDir)).toMatchObject({
            refreshToken: 'old-refresh',
            generation: profile.generation,
          });
        }
        expect(store.resetCount).toBe(0);
      });
    },
  );

  it('fences a callback if the profile changed before token exchange', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          code_challenge_methods_supported: ['S256'],
        }),
      );
      await expect(
        login({
          dataDir,
          store,
          guard,
          clientId: 'public-client',
          fetch: fetcher,
          onAuthorizationUrl: async (address) => {
            const authorization = new URL(address);
            store.setProfile({ ...profile, generation: randomUUID(), subject: 'changed-during-login' });
            const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
            callback.search = new URLSearchParams({
              code: 'code',
              state: authorization.searchParams.get('state') ?? '',
              iss: ISSUER,
            }).toString();
            const accepted = await fetch(callback);
            await accepted.text();
          },
        }),
      ).rejects.toMatchObject({ code: 'profile_changed' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readCredentials(dataDir)).toBeUndefined();
    });
  });
});

describe('local credential files and locking', () => {
  it('retries an atomic credential replacement without blocking cached history', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => seed({ dataDir, store, guard }, profile));
    const filename = join(dataDir, 'credentials.json');
    const replacement = join(dataDir, 'replacement.json');
    const credentials = await readCredentials(dataDir);
    await createPrivateWindowsFile(replacement);
    await writeFile(replacement, JSON.stringify({ ...credentials, refreshToken: 'rotated-refresh' }), { mode: 0o600 });
    const originalOpen = fileSystem.open;
    const opening = vi.spyOn(fileSystem, 'open').mockImplementationOnce(async (...argumentsList) => {
      await rename(replacement, filename);
      return originalOpen(...argumentsList);
    });
    try {
      await expect(assertCachedCredentials({ dataDir, store })).resolves.toEqual(profile);
      expect(opening).toHaveBeenCalledTimes(2);
    } finally {
      opening.mockRestore();
    }
    expect(await readCredentials(dataDir)).toMatchObject({ refreshToken: 'rotated-refresh' });
  });

  it('bounds repeated inode races and never retries unsafe replacement permissions', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => seed({ dataDir, store, guard }, profile));
    const filename = join(dataDir, 'credentials.json');
    const contents = await readFile(filename, 'utf8');
    const originalOpen = fileSystem.open;
    let mode = 0o600;
    const opening = vi.spyOn(fileSystem, 'open').mockImplementation(async (...argumentsList) => {
      const replacement = join(dataDir, `${randomUUID()}.json`);
      await createPrivateWindowsFile(replacement);
      await writeFile(replacement, contents, { mode });
      await rename(replacement, filename);
      return originalOpen(...argumentsList);
    });
    try {
      await expect(readCredentials(dataDir)).rejects.toMatchObject({ code: 'credentials_changed' });
      expect(opening).toHaveBeenCalledTimes(3);
      if (process.platform !== 'win32') {
        opening.mockClear();
        mode = 0o644;
        await expect(readCredentials(dataDir)).rejects.toMatchObject({ code: 'unsafe_credentials' });
        expect(opening).toHaveBeenCalledTimes(1);
      }
    } finally {
      opening.mockRestore();
    }
  });

  it('writes owner-only credentials and rejects symlinks or broad permissions', async () => {
    const { dataDir, store, profile } = await fixture();
    await withProfileLock(dataDir, async (guard) => {
      await seed({ dataDir, store, guard }, profile);
      const filename = join(dataDir, 'credentials.json');
      if (process.platform !== 'win32') {
        expect((await lstat(filename)).mode & 0o777).toBe(0o600);
        await chmod(filename, 0o644);
        await expect(readCredentials(dataDir)).rejects.toMatchObject({ code: 'unsafe_credentials' });
        await chmod(filename, 0o600);
        const copied = join(dataDir, 'copy.json');
        await writeFile(copied, await readFile(filename), { mode: 0o600 });
        await rm(filename);
        await symlink(copied, filename);
        await expect(readCredentials(dataDir)).rejects.toMatchObject({ code: 'unsafe_credentials' });
      }
    });
  });

  it('serializes competing clients and invalidates a released guard', async () => {
    const { dataDir } = await fixture();
    const order: string[] = [];
    let releasedGuard: ProfileLock | undefined;
    let enterFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const first = withProfileLock(dataDir, async (guard) => {
      releasedGuard = guard;
      order.push('first-enter');
      enterFirst();
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push('first-exit');
    });
    await entered;
    await Promise.all([
      first,
      withProfileLock(dataDir, async () => {
        order.push('second-enter');
      }),
    ]);
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
    expect(() => releasedGuard?.assertHeld()).toThrow('lock was lost');
  });

  it('does not follow symlink data directories', async () => {
    if (process.platform === 'win32') return;
    const { dataDir } = await fixture();
    const alias = join(dataDir, 'alias');
    await symlink(dataDir, alias);
    await expect(ensurePrivateDirectory(alias)).rejects.toMatchObject({ code: 'unsafe_directory' });
  });

  it('allows canonical system-parent aliases without following a symlink leaf', async () => {
    if (process.platform === 'win32') return;
    const { dataDir } = await fixture();
    const parentAlias = join(dataDir, 'system-parent');
    await symlink(dataDir, parentAlias);
    await expect(ensurePrivateDirectory(join(parentAlias, 'private-leaf'))).resolves.toBeUndefined();
    expect((await lstat(join(dataDir, 'private-leaf'))).isDirectory()).toBe(true);
  });
});
