import { describe, expect, it, vi } from 'vite-plus/test';
import { createGymMcpClientDiscovery } from '../gym-mcp-clients';
import type { PartnerDatabase } from '../tables';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { readGymMcpConfiguration } from '../../../mcp/gyms/configuration';

const CLIENT_ID = 'https://assistant.example/oauth/client.json';
const document = {
  client_id: CLIENT_ID,
  client_name: 'Test assistant',
  redirect_uris: ['https://assistant.example/callback'],
  token_endpoint_auth_method: 'none',
};

function authorize(clientId = CLIENT_ID): Request {
  const query = new URLSearchParams({ client_id: clientId, resource: 'https://api.boardsesh.com/mcp/gyms' });
  return new Request(`https://api.boardsesh.test/api/auth/oauth2/authorize?${query}`);
}

function createDiscovery(fetchMetadata: ClientMetadataResourceFetch) {
  return createGymMcpClientDiscovery({} as unknown as PartnerDatabase, { fetchMetadata });
}

describe('gym MCP metadata preparation', () => {
  it.each([
    CLIENT_ID,
    'https://chatgpt.com.attacker.example/oauth/client.json',
    'https://sub.claude.ai/client.json',
    'https://chatgpt.com:8443/oauth/client.json',
  ])('refuses untrusted pilot identities before fetching or entering OAuth: %s', async (clientId) => {
    const fetchMetadata = vi.fn();
    const clients = createGymMcpClientDiscovery({} as unknown as PartnerDatabase, {
      fetchMetadata,
      configuration: { mode: 'pilot', pilotUserIds: [] },
    });
    const work = vi.fn();
    expect((await clients.withPreparedMetadata(authorize(clientId), work)).status).toBe(400);
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it.each(['https://chatgpt.com/oauth/client.json', 'https://claude.ai/oauth/mcp-oauth-client-metadata'])(
    'prepares a default pilot identity without requiring a session: %s',
    async (clientId) => {
      const metadata = { ...document, client_id: clientId, redirect_uris: [new URL('/callback', clientId).href] };
      const fetchMetadata = vi.fn<ClientMetadataResourceFetch>(async () => Response.json(metadata));
      const clients = createGymMcpClientDiscovery({} as unknown as PartnerDatabase, {
        fetchMetadata,
        configuration: { mode: 'pilot', pilotUserIds: [] },
      });
      const work = vi.fn(async () => new Response());
      expect((await clients.withPreparedMetadata(authorize(clientId), work)).status).toBe(200);
      expect(fetchMetadata).toHaveBeenCalledOnce();
      expect(work).toHaveBeenCalledOnce();
    },
  );

  it('uses the configured pilot origins and fails closed for an empty list', async () => {
    const fetchMetadata = vi.fn<ClientMetadataResourceFetch>(async () => Response.json(document));
    for (const origins of ['https://assistant.example,https://chatgpt.com', '']) {
      const clients = createGymMcpClientDiscovery({} as unknown as PartnerDatabase, {
        fetchMetadata,
        configuration: readGymMcpConfiguration({
          NODE_ENV: 'test',
          GYM_MCP_MODE: 'pilot',
          GYM_MCP_PILOT_CLIENT_ORIGINS: origins,
        }),
      });
      const work = vi.fn(async () => new Response());
      expect((await clients.withPreparedMetadata(authorize(), work)).status).toBe(origins ? 200 : 400);
      expect(work).toHaveBeenCalledTimes(origins ? 1 : 0);
    }
    expect(fetchMetadata).toHaveBeenCalledOnce();
  });

  it.each([
    'http://assistant.example',
    'https://assistant.example/path',
    'https://user:secret@assistant.example',
    'invalid',
  ])('fails closed only for gym metadata with malformed pilot origins: %s', async (origins) => {
    const configuration = readGymMcpConfiguration({
      NODE_ENV: 'test',
      GYM_MCP_MODE: 'pilot',
      GYM_MCP_PILOT_CLIENT_ORIGINS: origins,
    });
    expect(configuration?.pilotClientOrigins).toEqual([]);
    const fetchMetadata = vi.fn();
    const clients = createGymMcpClientDiscovery({} as unknown as PartnerDatabase, { fetchMetadata, configuration });
    const work = vi.fn(async () => new Response('training'));
    expect((await clients.withPreparedMetadata(authorize('https://chatgpt.com/oauth/client.json'), work)).status).toBe(
      400,
    );
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(await (await clients.withPreparedMetadata(authorize('training_client_id'), work)).text()).toBe('training');
    expect(work).toHaveBeenCalledOnce();
  });

  it('times out the entire preparation when the transport ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const clients = createDiscovery(async () => new Promise<Response>(() => {}));
      const work = vi.fn(async () => new Response());
      const result = clients.withPreparedMetadata(authorize(), work);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await result).status).toBe(503);
      expect(work).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('finishes the bounded secure fetch before entering the OAuth operation', async () => {
    const order: string[] = [];
    const fetchMetadata = vi.fn<ClientMetadataResourceFetch>(async () => {
      order.push('network');
      return Response.json(document);
    });
    const clients = createDiscovery(fetchMetadata);
    const response = await clients.withPreparedMetadata(authorize(), async () => {
      order.push('oauth');
      return clients.discovery.fetchClientMetadataResource!(CLIENT_ID);
    });
    expect(await response.json()).toEqual(document);
    expect(order).toEqual(['network', 'oauth']);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchMetadata.mock.calls[0]).toEqual([
      CLIENT_ID,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    ]);
    await expect(clients.discovery.fetchClientMetadataResource!(CLIENT_ID)).rejects.toThrow('not prepared');
  });

  it('does not fetch managed partner identities', async () => {
    const fetchMetadata = vi.fn();
    const clients = createDiscovery(fetchMetadata);
    const response = await clients.withPreparedMetadata(
      authorize('partner_public_id'),
      async () => new Response('legacy'),
    );
    expect(await response.text()).toBe('legacy');
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it('bounds validated cache freshness and honors responses that forbid shared caching', async () => {
    for (const cacheControl of [
      'public, max-age=600',
      'no-store',
      'private',
      'no-cache',
      'max-age=0',
      'max-age=60, max-age=120',
      's-maxage, max-age=600',
    ]) {
      const fetchMetadata = vi.fn<ClientMetadataResourceFetch>(async () =>
        Response.json(document, { headers: { 'cache-control': cacheControl } }),
      );
      const clients = createDiscovery(fetchMetadata);
      for (let call = 0; call < 2; call += 1) {
        expect((await clients.withPreparedMetadata(authorize(), async () => new Response())).status).toBe(200);
      }
      expect(fetchMetadata).toHaveBeenCalledTimes(cacheControl.startsWith('public') ? 1 : 2);
    }
  });

  it('negotiates public PKCE when ChatGPT advertises none alongside its legacy JWT preference', async () => {
    const clients = createDiscovery(async () =>
      Response.json({
        ...document,
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        jwks_uri: 'https://assistant.example/oauth/jwks.json',
      }),
    );
    const response = await clients.withPreparedMetadata(authorize(), async () =>
      clients.discovery.fetchClientMetadataResource!(CLIENT_ID),
    );
    const received: unknown = await response.json();
    expect(received).toEqual(expect.objectContaining({ token_endpoint_auth_method: 'none' }));
    expect(received).not.toHaveProperty('jwks_uri');
  });

  it.each([
    'https://127.0.0.1/client.json',
    'https://169.254.169.254/client.json',
    'https://localhost/client.json',
    'https://assistant.example/client.json#fragment',
  ])('refuses unsafe client identifiers before fetching: %s', async (clientId) => {
    const fetchMetadata = vi.fn();
    const clients = createDiscovery(fetchMetadata);
    const work = vi.fn();
    const response = await clients.withPreparedMetadata(authorize(clientId), work);
    expect(response.status).toBe(400);
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    { ...document, client_id: 'https://different.example/client.json' },
    { ...document, token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://assistant.example/keys.json' },
    { ...document, token_endpoint_auth_method: 'client_secret_post' },
    { ...document, client_name: '' },
  ])('does not start OAuth for invalid or secret-bearing metadata', async (metadata) => {
    const clients = createDiscovery(async () => Response.json(metadata));
    const work = vi.fn();
    const response = await clients.withPreparedMetadata(authorize(), work);
    expect(response.status).toBe(400);
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects redirects and oversized documents before OAuth starts', async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: CLIENT_ID } }),
      Response.json({ ...document, description: 'x'.repeat(6000) }),
    ]) {
      const clients = createDiscovery(async () => response);
      const work = vi.fn();
      expect((await clients.withPreparedMetadata(authorize(), work)).status).toBe(400);
      expect(work).not.toHaveBeenCalled();
    }
  });

  it('prepares form token and signed consent requests without forwarding credentials', async () => {
    const fetchMetadata = vi.fn<ClientMetadataResourceFetch>(async () => Response.json(document));
    const clients = createDiscovery(fetchMetadata);
    const token = new Request('https://api.boardsesh.test/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'private=cookie' },
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'authorization_code', code: 'private-code' }),
    });
    const consent = new Request('https://api.boardsesh.test/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oauth_query: new URLSearchParams({ client_id: CLIENT_ID }).toString(), accept: true }),
    });
    for (const request of [token, consent])
      expect((await clients.withPreparedMetadata(request, async () => new Response())).status).toBe(200);
    for (const call of fetchMetadata.mock.calls)
      expect(call[1]).toEqual(expect.objectContaining({ headers: { accept: 'application/json' } }));
  });
});
