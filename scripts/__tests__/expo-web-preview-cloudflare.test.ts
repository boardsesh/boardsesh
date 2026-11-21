/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import { createCloudflareClient, PREVIEW_PROJECT } from '../lib/expo-web-preview-cloudflare.mjs';

const SHA = 'a'.repeat(40);
const PROJECT_PATH = `/accounts/account/pages/projects/${PREVIEW_PROJECT}`;
const project = { name: PREVIEW_PROJECT, production_branch: 'main' };
const domain = { name: 'pr-42.boardsesh.com' };
const record = {
  id: 'record42',
  type: 'CNAME',
  name: domain.name,
  content: `pr-42.${PREVIEW_PROJECT}.pages.dev`,
  proxied: true,
  comment: 'boardsesh:web-preview:pr-42',
};

type ApiResult = {
  result?: unknown;
  status?: number;
  success?: boolean;
  resultInfo?: Record<string, unknown>;
  errors?: unknown[];
};
type ApiRequest = { method: string; url: URL; body?: unknown; init?: RequestInit };
type ApiHandler = (request: ApiRequest) => ApiResult | Promise<ApiResult>;

function apiMock(handler: ApiHandler) {
  const calls: ApiRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      init,
    };
    calls.push(call);
    const output = await handler(call);
    return Response.json(
      {
        success: output.success ?? (output.status ?? 200) < 400,
        result: output.result ?? null,
        ...(output.resultInfo ? { result_info: output.resultInfo } : {}),
        ...(output.errors ? { errors: output.errors } : {}),
      },
      { status: output.status ?? 200 },
    );
  };
  return { fetchImpl, calls, mutations: () => calls.filter((call) => call.method !== 'GET') };
}

function client(fetchImpl: typeof fetch) {
  return createCloudflareClient({
    token: 'private-test-token',
    accountId: 'account',
    zoneId: 'zone',
    fetch: fetchImpl,
    sleep: async () => undefined,
  });
}

function normalApi(request: ApiRequest): ApiResult {
  if (request.url.pathname === `/client/v4${PROJECT_PATH}`) return { result: project };
  if (request.url.pathname.endsWith('/domains')) return { result: [domain] };
  if (request.url.pathname.endsWith('/dns_records')) return { result: [record] };
  if (request.url.pathname.endsWith('/deployments')) return { result: [] };
  if (request.method === 'DELETE' || request.method === 'PATCH') return { result: {} };
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

describe('Cloudflare web preview ownership and provisioning', () => {
  it.each([0, -1, 1.5, '01', '42/../../main', Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid PR number %s without an API request',
    async (prNumber) => {
      const mock = apiMock(normalApi);
      await expect(client(mock.fetchImpl).ensurePreviewDomain(prNumber)).rejects.toThrow('positive safe integer');
      expect(mock.calls).toHaveLength(0);
    },
  );

  it('creates only the dedicated direct-upload project, reserving main for the placeholder', async () => {
    const mock = apiMock(({ method, url, body }) => {
      if (method === 'GET' && url.pathname.endsWith(PREVIEW_PROJECT)) return { status: 404 };
      expect(method).toBe('POST');
      expect(url.pathname).toBe('/client/v4/accounts/account/pages/projects');
      expect(body).toEqual(project);
      return { result: project };
    });
    await expect(client(mock.fetchImpl).ensureProject()).resolves.toEqual(project);
    expect(mock.mutations()).toHaveLength(1);
    expect(
      mock.calls.every((call) => call.init?.redirect === 'error' && call.init?.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it.each([
    { ...project, production_branch: 'pr-42' },
    { ...project, source: { type: 'github' } },
    { ...project, name: 'boardsesh-app' },
  ])('refuses an unexpected project configuration', async (configuration) => {
    const mock = apiMock(() => ({ result: configuration }));
    await expect(client(mock.fetchImpl).ensureProject()).rejects.toThrow('direct-upload Pages project');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('accepts a concurrent initial create only after verifying the project', async () => {
    let reads = 0;
    const mock = apiMock(({ method }) => {
      if (method === 'POST') return { status: 409 };
      reads += 1;
      return reads === 1 ? { status: 404 } : { result: project };
    });
    await expect(client(mock.fetchImpl).ensureProject()).resolves.toEqual(project);
    expect(reads).toBe(2);
  });

  it('does not mutate an already-correct numbered branch domain', async () => {
    const mock = apiMock(normalApi);
    await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).resolves.toEqual({
      hostname: domain.name,
      branch: 'pr-42',
      url: 'https://pr-42.boardsesh.com',
    });
    expect(mock.mutations()).toHaveLength(0);
  });

  it('attaches a new domain and adopts only the CNAME Pages just created for that project', async () => {
    let attached = false;
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) {
        if (request.method === 'POST') {
          expect(request.body).toEqual({ name: domain.name });
          attached = true;
          return { result: domain };
        }
        return { result: [] };
      }
      if (request.url.pathname.endsWith('/dns_records'))
        return { result: attached ? [{ ...record, content: `${PREVIEW_PROJECT}.pages.dev`, comment: '' }] : [] };
      return normalApi(request);
    });
    await client(mock.fetchImpl).ensurePreviewDomain(42);
    expect(mock.mutations().map((call) => [call.method, call.url.pathname])).toEqual([
      ['POST', `/client/v4${PROJECT_PATH}/domains`],
      ['PATCH', '/client/v4/zones/zone/dns_records/record42'],
    ]);
    expect(mock.mutations()[1]?.body).toMatchObject({
      content: record.content,
      proxied: true,
      comment: record.comment,
    });
  });

  it('creates a marked DNS alias when Pages does not create one', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) return { result: request.method === 'POST' ? domain : [] };
      if (request.url.pathname.endsWith('/dns_records')) return { result: request.method === 'POST' ? record : [] };
      return normalApi(request);
    });
    await client(mock.fetchImpl).ensurePreviewDomain('42');
    expect(mock.mutations()[1]?.body).toEqual({
      type: 'CNAME',
      name: domain.name,
      content: record.content,
      proxied: true,
      ttl: 1,
      comment: record.comment,
    });
  });

  it.each([
    { ...record, comment: '', content: 'other.pages.dev' },
    { ...record, comment: 'another-owner' },
    { ...record, type: 'A', content: '192.0.2.1' },
  ])('preserves unrelated DNS before attaching a domain', async (existingRecord) => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) return { result: [] };
      if (request.url.pathname.endsWith('/dns_records')) return { result: [existingRecord] };
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).rejects.toThrow('unrelated DNS');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('does not adopt an unmarked record merely because its target looks like the preview project', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) return { result: [] };
      if (request.url.pathname.endsWith('/dns_records')) return { result: [{ ...record, comment: '' }] };
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).rejects.toThrow('unrelated DNS');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('fails at the Free domain cap before any provisioning mutation', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/domains')
        ? {
            result: Array.from({ length: 100 }, (_, index) => ({ name: `pr-${index + 100}.boardsesh.com` })),
            resultInfo: { page: 1, total_pages: 1 },
          }
        : normalApi(request),
    );
    await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).rejects.toThrow('capacity reached (100/100)');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('accepts a complete legacy SinglePage of 100 domains without requesting another page', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) {
        expect(request.url.searchParams.get('page')).toBe('1');
        expect(request.url.searchParams.get('per_page')).toBe('25');
        return { result: Array.from({ length: 100 }, (_, index) => ({ name: `pr-${index + 100}.boardsesh.com` })) };
      }
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).rejects.toThrow('capacity reached (100/100)');
    expect(mock.calls.filter((request) => request.url.pathname.endsWith('/domains'))).toHaveLength(1);
    expect(mock.mutations()).toHaveLength(0);
  });

  it.each(['total_pages', 'total_count'] as const)(
    'checks all four 25-domain pages using %s before enforcing capacity',
    async (totalField) => {
      const mock = apiMock((request) => {
        if (request.url.pathname.endsWith('/domains')) {
          const page = Number(request.url.searchParams.get('page'));
          expect(request.url.searchParams.get('per_page')).toBe('25');
          expect(page).toBeLessThanOrEqual(4);
          return {
            result: Array.from({ length: 25 }, (_, index) => ({
              name: `pr-${100 + (page - 1) * 25 + index}.boardsesh.com`,
            })),
            resultInfo: { page, per_page: 25, [totalField]: totalField === 'total_pages' ? 4 : 100 },
          };
        }
        return normalApi(request);
      });
      await expect(client(mock.fetchImpl).ensurePreviewDomain(42)).rejects.toThrow('capacity reached (100/100)');
      expect(mock.calls.filter((request) => request.url.pathname.endsWith('/domains'))).toHaveLength(4);
      expect(mock.mutations()).toHaveLength(0);
    },
  );

  it('rejects Cloudflare success=false even when the HTTP status is 200', async () => {
    const mock = apiMock(() => ({ success: false, errors: [{ code: 10000, message: 'Missing Pages scope' }] }));
    await expect(client(mock.fetchImpl).ensureProject()).rejects.toThrow('10000: Missing Pages scope');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('resolves the exact zone once and follows pagination metadata', async () => {
    const mock = apiMock((request) =>
      request.url.pathname === '/client/v4/zones'
        ? { result: [{ id: 'zone', name: 'boardsesh.com' }] }
        : normalApi(request),
    );
    const previewClient = createCloudflareClient({ token: 'token', accountId: 'account', fetch: mock.fetchImpl });
    await previewClient.ensurePreviewDomain(42);
    await previewClient.ensurePreviewDomain(42);
    expect(mock.calls.filter((call) => call.url.pathname === '/client/v4/zones')).toHaveLength(1);
  });
});

function deployment(prNumber: number, sha: string, createdOn: string, id = `deployment${prNumber}`) {
  return {
    id,
    environment: 'preview',
    created_on: createdOn,
    deployment_trigger: { metadata: { branch: `pr-${prNumber}`, commit_hash: sha } },
  };
}

describe('Cloudflare web preview cleanup and retention discovery', () => {
  it('checks every declared domain page before deleting the requested hostname', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains') && request.method === 'GET') {
        const page = Number(request.url.searchParams.get('page'));
        return {
          result: Array.from({ length: 25 }, (_, index) => ({
            name: `pr-${(page - 1) * 25 + index + 1}.boardsesh.com`,
          })),
          resultInfo: { page, per_page: 25, total_count: 100 },
        };
      }
      return normalApi(request);
    });
    await client(mock.fetchImpl).removePreview(42);
    const firstDelete = mock.calls.findIndex((request) => request.method === 'DELETE');
    expect(
      mock.calls.slice(0, firstDelete).filter((request) => request.url.pathname.endsWith('/domains')),
    ).toHaveLength(4);
    expect(mock.mutations().map((request) => request.url.pathname)).toEqual([
      '/client/v4/zones/zone/dns_records/record42',
      `/client/v4${PROJECT_PATH}/domains/pr-42.boardsesh.com`,
    ]);
  });

  it('keeps deployments paginated when a full page has no metadata', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/deployments')) {
        expect(request.url.searchParams.get('per_page')).toBe('25');
        return request.url.searchParams.get('page') === '1'
          ? {
              result: [
                deployment(42, SHA, '2026-11-20T00:00:00Z'),
                ...Array.from({ length: 24 }, (_, index) => deployment(100 + index, SHA, '2026-11-20T00:00:00Z')),
              ],
            }
          : { result: [deployment(42, SHA, '2026-11-21T00:00:00Z', 'deployment42b')] };
      }
      return normalApi(request);
    });
    await client(mock.fetchImpl).removePreview(42);
    expect(mock.calls.filter((request) => request.url.pathname.endsWith('/deployments'))).toHaveLength(2);
    expect(mock.mutations().filter((request) => request.url.pathname.includes('/deployments/'))).toHaveLength(2);
  });

  it.each([
    { page: 1, per_page: 25, total_count: -1 },
    { page: 99, per_page: 25, total_count: 1 },
    { page: 1, per_page: 25, total_pages: 1, total_count: 100 },
  ])('does not delete resources from an inconsistent domain listing %j', async (resultInfo) => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/domains') ? { result: [domain], resultInfo } : normalApi(request),
    );
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow(
      /pagination metadata|truncated or inconsistent listing/,
    );
    expect(mock.mutations()).toHaveLength(0);
  });

  it('does not accept a short first page or empty next page before total_count is satisfied', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) {
        const page = Number(request.url.searchParams.get('page'));
        return { result: page === 1 ? [domain] : [], resultInfo: { page, per_page: 25, total_count: 100 } };
      }
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('truncated listing before its final page');
    expect(mock.calls.filter((request) => request.url.pathname.endsWith('/domains'))).toHaveLength(2);
    expect(mock.mutations()).toHaveLength(0);
  });

  it('collects the newest exact branch revision and orphan domains/DNS across all pages', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains'))
        return { result: [domain, { name: 'pr-77.boardsesh.com' }, { name: 'app.boardsesh.com' }] };
      if (request.url.pathname.endsWith('/deployments')) {
        const first = request.url.searchParams.get('page') === '1';
        return {
          result: first
            ? [deployment(42, 'b'.repeat(40), '2026-11-20T00:00:00Z')]
            : [
                deployment(42, SHA, '2026-11-21T00:00:00Z'),
                { ...deployment(1, SHA, '2026-11-21T00:00:00Z'), environment: 'production' },
              ],
          resultInfo: { page: first ? 1 : 2, total_pages: 2 },
        };
      }
      if (request.url.pathname.endsWith('/dns_records'))
        return {
          result: [
            {
              ...record,
              id: 'record88',
              name: 'pr-88.boardsesh.com',
              content: `pr-88.${PREVIEW_PROJECT}.pages.dev`,
              comment: 'boardsesh:web-preview:pr-88',
            },
            { ...record, name: 'pr-99.boardsesh.com', comment: 'someone-else' },
          ],
        };
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).listPreviews()).resolves.toEqual([
      { prNumber: 42, sha: SHA, createdOn: '2026-11-21T00:00:00Z' },
      { prNumber: 77 },
      { prNumber: 88 },
    ]);
    expect(mock.mutations()).toHaveLength(0);
  });

  it('deletes only the requested preview after all pages have been checked', async () => {
    const mock = apiMock((request) => {
      if (request.method === 'GET' && request.url.pathname.endsWith('/deployments')) {
        const first = request.url.searchParams.get('page') === '1';
        return {
          result: first
            ? [deployment(42, SHA, '2026-11-20T00:00:00Z'), deployment(43, SHA, '2026-11-21T00:00:00Z')]
            : [deployment(42, SHA, '2026-11-21T00:00:00Z', 'deployment42b')],
          resultInfo: { page: first ? 1 : 2, total_pages: 2 },
        };
      }
      return normalApi(request);
    });
    await client(mock.fetchImpl).removePreview(42);
    expect(mock.mutations().map((call) => call.url.pathname)).toEqual([
      '/client/v4/zones/zone/dns_records/record42',
      `/client/v4${PROJECT_PATH}/domains/pr-42.boardsesh.com`,
      `/client/v4${PROJECT_PATH}/deployments/deployment42`,
      `/client/v4${PROJECT_PATH}/deployments/deployment42b`,
    ]);
    expect(
      mock
        .mutations()
        .filter((call) => call.url.pathname.includes('/deployments/'))
        .every((call) => call.url.searchParams.get('force') === 'true'),
    ).toBe(true);
    const firstDelete = mock.calls.findIndex((call) => call.method === 'DELETE');
    expect(mock.calls.slice(firstDelete).every((call) => call.method === 'DELETE')).toBe(true);
  });

  it('does not delete anything after a later listing page fails', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/deployments')
        ? request.url.searchParams.get('page') === '1'
          ? { result: [deployment(42, SHA, '2026-11-21T00:00:00Z')], resultInfo: { page: 1, total_pages: 2 } }
          : { status: 503, errors: [{ code: 1, message: 'temporary outage' }] }
        : normalApi(request),
    );
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('HTTP 503');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('refuses to delete a production deployment even if it has a numbered branch', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/deployments')
        ? { result: [{ ...deployment(42, SHA, '2026-11-21T00:00:00Z'), environment: 'production' }] }
        : normalApi(request),
    );
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('non-preview deployment');
    expect(mock.mutations()).toHaveLength(0);
  });

  it('cleans an orphan marked DNS record after the preview project was removed', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith(PREVIEW_PROJECT)
        ? { status: 404 }
        : request.method === 'DELETE'
          ? { status: 404 }
          : normalApi(request),
    );
    await client(mock.fetchImpl).removePreview(42);
    expect(mock.mutations().map((call) => call.url.pathname)).toEqual(['/client/v4/zones/zone/dns_records/record42']);
  });

  it('refuses unrelated DNS before removing the domain or deployments', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/dns_records')
        ? { result: [{ ...record, content: 'owner-edited.example.com' }] }
        : normalApi(request),
    );
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('unrelated DNS');
    expect(mock.mutations()).toHaveLength(0);
  });
});

function previewSite(override?: (path: string) => Response | undefined): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe('https://pr-42.boardsesh.com');
    expect(init?.headers).toBeUndefined();
    expect(init?.redirect).toBe('error');
    const replacement = override?.(url.pathname);
    if (replacement) return replacement;
    if (url.pathname === '/' || url.pathname === '/climbs')
      return new Response(
        '<html><head><link rel="manifest" href="/manifest.json"></head><body><div id="root"></div><script src="/_expo/main.js"></script></body></html>',
        {
          headers: {
            'content-type': 'text/html',
            'x-robots-tag': 'noindex',
            'cache-control': 'max-age=0, must-revalidate',
          },
        },
      );
    if (url.pathname === '/preview-meta.json') return Response.json({ prNumber: 42, sha: SHA });
    if (url.pathname === '/manifest.json') return Response.json({ start_url: '/', scope: '/' });
    if (url.pathname === '/wasm/board_renderer_wasm_bg.wasm')
      return new Response(new Uint8Array([0, 97, 115, 109]), { headers: { 'content-type': 'application/wasm' } });
    if (url.pathname === '/_expo/main.js')
      return new Response('console.log("Expo");', {
        headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  };
}

describe('deployed preview HTTPS smoke', () => {
  it('verifies the exact PR revision, real Expo shell, chunks, PWA and WASM without sending API credentials', async () => {
    await expect(client(previewSite()).smokePreview(42, SHA)).resolves.toBe('https://pr-42.boardsesh.com');
  });

  it('retries certificate/edge propagation failures before marking a preview ready', async () => {
    let connections = 0;
    const site = previewSite();
    const fetchImpl: typeof fetch = async (input, init) => {
      connections += 1;
      if (connections <= 6) throw new TypeError('certificate not ready');
      return site(input, init);
    };
    const sleep = vi.fn(async () => undefined);
    const previewClient = createCloudflareClient({ token: 'secret', accountId: 'account', fetch: fetchImpl, sleep });
    await expect(previewClient.smokePreview(42, SHA)).resolves.toBe('https://pr-42.boardsesh.com');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it.each([
    ['/preview-meta.json', () => Response.json({ prNumber: 43, sha: SHA }), 'different PR'],
    ['/preview-meta.json', () => Response.json({ prNumber: 42, sha: 'b'.repeat(40) }), 'different PR'],
    ['/manifest.json', () => Response.json({ start_url: '/app/', scope: '/app/' }), 'start and scope'],
    [
      '/_expo/main.js',
      () => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }),
      'JavaScript',
    ],
    [
      '/wasm/board_renderer_wasm_bg.wasm',
      () => new Response('not WASM', { headers: { 'content-type': 'application/wasm' } }),
      'not a WASM binary',
    ],
    [
      '/_expo/static/js/web/boardsesh-preview-missing.js',
      () => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }),
      'HTTP 404',
    ],
  ] as const)('fails visibly when %s serves invalid preview content', async (path, replacement, message) => {
    const site = previewSite((requestedPath) => (requestedPath === path ? replacement() : undefined));
    await expect(client(site).smokePreview(42, SHA)).rejects.toThrow(message);
  });
});
