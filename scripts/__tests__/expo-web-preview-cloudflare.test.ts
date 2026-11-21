/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflareClient,
  PREVIEW_PROJECT,
  RETIRED_COMMIT_MESSAGE,
  RETIRED_COMMIT_SHA,
  type PreviewDomain,
} from '../lib/expo-web-preview-cloudflare.mjs';

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

function client(
  fetchImpl: typeof fetch,
  retireDeployment?: (identity: PreviewDomain & { prNumber: number }) => Promise<void>,
) {
  return createCloudflareClient({
    token: 'private-test-token',
    accountId: 'account',
    zoneId: 'zone',
    fetch: fetchImpl,
    retireDeployment,
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

function retiredDeployment(prNumber = 42, id = `retired${prNumber}`, status = 'success', stageName = 'deploy') {
  const retired = deployment(prNumber, RETIRED_COMMIT_SHA, '2026-11-22T00:00:00Z', id);
  return {
    ...retired,
    deployment_trigger: {
      metadata: { ...retired.deployment_trigger.metadata, commit_message: RETIRED_COMMIT_MESSAGE },
    },
    latest_stage: { name: stageName, status },
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
          : { result: [deployment(42, SHA, '2026-11-21T00:00:00Z', 'deployment42b'), retiredDeployment()] };
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
            : [deployment(42, SHA, '2026-11-21T00:00:00Z', 'deployment42b'), retiredDeployment()],
          resultInfo: { page: first ? 1 : 2, total_pages: 2 },
        };
      }
      return normalApi(request);
    });
    await client(mock.fetchImpl).removePreview(42);
    expect(mock.mutations().map((call) => call.url.pathname)).toEqual([
      '/client/v4/zones/zone/dns_records/record42',
      `/client/v4${PROJECT_PATH}/domains/pr-42.boardsesh.com`,
      `/client/v4${PROJECT_PATH}/deployments/deployment42b`,
      `/client/v4${PROJECT_PATH}/deployments/deployment42`,
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

  it('retires a branch before cleanup, preserves the protected latest deployment and repeats idempotently', async () => {
    let storedDeployments = [
      deployment(42, SHA, '2026-11-20T00:00:00Z', 'app42old'),
      deployment(42, SHA, '2026-11-21T00:00:00Z', 'app42new'),
      deployment(43, SHA, '2026-11-21T00:00:00Z', 'app43'),
    ];
    let storedDomains = [domain, { name: 'pr-43.boardsesh.com' }];
    let storedRecords = [
      record,
      {
        ...record,
        id: 'record43',
        name: 'pr-43.boardsesh.com',
        content: `pr-43.${PREVIEW_PROJECT}.pages.dev`,
        comment: 'boardsesh:web-preview:pr-43',
      },
    ];
    let protectedDeletes = 0;
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/domains')) return { result: storedDomains };
      if (request.url.pathname.endsWith('/deployments')) return { result: storedDeployments };
      if (request.url.pathname.endsWith('/dns_records')) {
        const name = request.url.searchParams.get('name');
        return { result: name ? storedRecords.filter((entry) => entry.name === name) : storedRecords };
      }
      if (request.method === 'DELETE') {
        const id = request.url.pathname.split('/').at(-1);
        if (request.url.pathname.includes('/deployments/')) {
          const candidate = storedDeployments.find((entry) => entry.id === id);
          if (!candidate) return { status: 404 };
          const latest = storedDeployments
            .filter(
              (entry) => entry.deployment_trigger.metadata.branch === candidate.deployment_trigger.metadata.branch,
            )
            .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on))[0];
          if (candidate.id === latest?.id) {
            protectedDeletes += 1;
            return {
              status: 400,
              errors: [{ code: 1000, message: 'The latest deployment for a branch cannot be deleted.' }],
            };
          }
          storedDeployments = storedDeployments.filter((entry) => entry.id !== id);
        } else if (request.url.pathname.includes('/dns_records/')) {
          storedRecords = storedRecords.filter((entry) => entry.id !== id);
        } else if (request.url.pathname.includes('/domains/')) {
          storedDomains = storedDomains.filter((entry) => entry.name !== id);
        }
        return { result: {} };
      }
      return normalApi(request);
    });
    const retire = vi.fn(async (identity: PreviewDomain & { prNumber: number }) => {
      expect(identity).toEqual({
        prNumber: 42,
        branch: 'pr-42',
        hostname: domain.name,
        url: 'https://pr-42.boardsesh.com',
      });
      expect(mock.mutations()).toHaveLength(0);
      storedDeployments.push(retiredDeployment());
    });
    const previewClient = client(mock.fetchImpl, retire);
    await previewClient.removePreview(42);
    await previewClient.removePreview(42);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(protectedDeletes).toBe(0);
    expect(storedDeployments.map((entry) => entry.id).sort()).toEqual(['app43', 'retired42']);
    expect(storedDomains).toEqual([{ name: 'pr-43.boardsesh.com' }]);
    expect(storedRecords.map((entry) => entry.id)).toEqual(['record43']);
    await expect(previewClient.listPreviews()).resolves.toEqual([
      { prNumber: 43, sha: SHA, createdOn: '2026-11-21T00:00:00Z' },
    ]);
  });

  it('requires a retirement uploader before deleting resources from a live branch', async () => {
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/deployments')
        ? { result: [deployment(42, SHA, '2026-11-21T00:00:00Z')] }
        : normalApi(request),
    );
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('requires a trusted tombstone uploader');
    expect(mock.mutations()).toHaveLength(0);
  });

  it.each(['failure', 'idle', 'active'])(
    'does not delete resources after a %s retirement deployment',
    async (status) => {
      let retired = false;
      const mock = apiMock((request) =>
        request.url.pathname.endsWith('/deployments')
          ? {
              result: [
                deployment(42, SHA, '2026-11-21T00:00:00Z'),
                ...(retired ? [retiredDeployment(42, 'retired42', status)] : []),
              ],
            }
          : normalApi(request),
      );
      const retire = vi.fn(async () => {
        retired = true;
      });
      await expect(client(mock.fetchImpl, retire).removePreview(42)).rejects.toThrow(
        'not the successful trusted retirement marker',
      );
      expect(retire).toHaveBeenCalledTimes(1);
      expect(mock.mutations()).toHaveLength(0);
    },
  );

  it('does not accept a successful deployment with the wrong retirement message', async () => {
    let uploaded = false;
    const retired = retiredDeployment();
    const candidate = {
      ...retired,
      deployment_trigger: { metadata: { ...retired.deployment_trigger.metadata, commit_message: 'some other upload' } },
    };
    const mock = apiMock((request) =>
      request.url.pathname.endsWith('/deployments')
        ? { result: [deployment(42, SHA, '2026-11-21T00:00:00Z'), ...(uploaded ? [candidate] : [])] }
        : normalApi(request),
    );
    await expect(
      client(mock.fetchImpl, async () => {
        uploaded = true;
      }).removePreview(42),
    ).rejects.toThrow('not the successful trusted retirement marker');
    expect(mock.mutations()).toHaveLength(0);
  });

  it.each(['build', 'initialize'])(
    'does not delete resources after an intermediate %s stage succeeds',
    async (stageName) => {
      let uploaded = false;
      const mock = apiMock((request) =>
        request.url.pathname.endsWith('/deployments')
          ? {
              result: [
                deployment(42, SHA, '2026-11-21T00:00:00Z'),
                ...(uploaded ? [retiredDeployment(42, 'retired42', 'success', stageName)] : []),
              ],
            }
          : normalApi(request),
      );
      await expect(
        client(mock.fetchImpl, async () => {
          uploaded = true;
        }).removePreview(42),
      ).rejects.toThrow('not the successful trusted retirement marker');
      expect(mock.mutations()).toHaveLength(0);
      expect(mock.calls.filter((request) => request.url.pathname.endsWith('/deployments'))).toHaveLength(13);
    },
  );

  it('waits for the final deploy stage before deleting the previous app', async () => {
    let uploaded = false;
    let propagationReads = 0;
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/deployments')) {
        if (uploaded) propagationReads += 1;
        return {
          result: [
            deployment(42, SHA, '2026-11-21T00:00:00Z'),
            ...(uploaded
              ? [retiredDeployment(42, 'retired42', 'success', propagationReads < 3 ? 'build' : 'deploy')]
              : []),
          ],
        };
      }
      return normalApi(request);
    });
    const sleep = vi.fn(async () => {
      expect(mock.mutations()).toHaveLength(0);
    });
    const previewClient = createCloudflareClient({
      token: 'token',
      accountId: 'account',
      zoneId: 'zone',
      fetch: mock.fetchImpl,
      sleep,
      retireDeployment: async () => {
        uploaded = true;
      },
    });
    await previewClient.removePreview(42);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(propagationReads).toBe(3);
    expect(mock.mutations().map((request) => request.url.pathname)).toEqual([
      '/client/v4/zones/zone/dns_records/record42',
      `/client/v4${PROJECT_PATH}/domains/pr-42.boardsesh.com`,
      `/client/v4${PROJECT_PATH}/deployments/deployment42`,
    ]);
  });

  it('does not upload a retirement deployment when DNS ownership fails preflight', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/deployments'))
        return { result: [deployment(42, SHA, '2026-11-21T00:00:00Z')] };
      if (request.url.pathname.endsWith('/dns_records')) return { result: [{ ...record, comment: 'another-owner' }] };
      return normalApi(request);
    });
    const retire = vi.fn(async () => undefined);
    await expect(client(mock.fetchImpl, retire).removePreview(42)).rejects.toThrow('unrelated DNS');
    expect(retire).not.toHaveBeenCalled();
    expect(mock.mutations()).toHaveLength(0);
  });

  it.each(['domain', 'dns', 'old-app', 'failed-retirement'] as const)(
    'discovers a retired branch with remaining %s cleanup',
    async (remaining) => {
      const mock = apiMock((request) => {
        if (request.url.pathname.endsWith('/domains')) return { result: remaining === 'domain' ? [domain] : [] };
        if (request.url.pathname.endsWith('/dns_records')) return { result: remaining === 'dns' ? [record] : [] };
        if (request.url.pathname.endsWith('/deployments'))
          return {
            result: [
              retiredDeployment(42, 'retired42', remaining === 'failed-retirement' ? 'failure' : 'success'),
              ...(remaining === 'old-app' ? [deployment(42, SHA, '2026-11-21T00:00:00Z')] : []),
            ],
          };
        return normalApi(request);
      });
      const discovered = await client(mock.fetchImpl).listPreviews();
      expect(discovered.map((entry) => entry.prNumber)).toEqual([42]);
    },
  );

  it('surfaces an older deployment deletion failure instead of treating cleanup as successful', async () => {
    const mock = apiMock((request) => {
      if (request.url.pathname.endsWith('/deployments'))
        return { result: [deployment(42, SHA, '2026-11-21T00:00:00Z'), retiredDeployment()] };
      if (request.method === 'DELETE' && request.url.pathname.includes('/deployments/'))
        return { status: 403, errors: [{ code: 10000, message: 'Deployment delete denied' }] };
      return normalApi(request);
    });
    await expect(client(mock.fetchImpl).removePreview(42)).rejects.toThrow('Deployment delete denied');
  });
});

const ICON_FONT_PATHS = [
  '/assets/__node_modules/.pnpm/@expo+vector-icons@15.1.1_expo-font@58.0.12_react-native@0.88.1_patch_hash=5ba8e0b13c37_2c6d75089aa13f5f0102f080d0470763/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.6e435534bd35da5fef04168860a9b8fa.ttf',
  '/assets/__node_modules/.pnpm/@expo-google-fonts+material-symbols@0.4.44/node_modules/@expo-google-fonts/material-symbols/400Regular/MaterialSymbols_400Regular.96032e7aed600e905412ba2e0281f754.ttf',
];

function javascriptResponse(source: string) {
  return new Response(source, {
    headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

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
      return javascriptResponse(ICON_FONT_PATHS.map((path) => `module.exports="${path}";`).join(''));
    if (ICON_FONT_PATHS.includes(url.pathname))
      return new Response(new Uint8Array([0, 1, 0, 0]), { headers: { 'content-type': 'font/ttf' } });
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  };
}

describe('deployed preview HTTPS smoke', () => {
  it('verifies the exact PR revision, shell, chunks, icon fonts, PWA and WASM without API credentials', async () => {
    await expect(client(previewSite()).smokePreview(42, SHA)).resolves.toBe('https://pr-42.boardsesh.com');
  });

  it('reads font signatures across network chunks and deduplicates repeated references', async () => {
    const requestedFonts: string[] = [];
    const site = previewSite((path) => {
      if (path === '/_expo/main.js')
        return javascriptResponse(ICON_FONT_PATHS.flatMap((font) => [`'${font}'`, `"${font}"`]).join(';'));
      if (!ICON_FONT_PATHS.includes(path)) return undefined;
      requestedFonts.push(path);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of [0, 1, 0, 0]) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } },
      );
    });
    await expect(client(site).smokePreview(42, SHA)).resolves.toBe('https://pr-42.boardsesh.com');
    expect(requestedFonts).toEqual(ICON_FONT_PATHS);
  });

  it.each([
    ['/assets/../private/MaterialCommunityIcons.hash.ttf'],
    ['/assets/%2e%2e/private/MaterialCommunityIcons.hash.ttf'],
    ['/assets/font.ttf?redirect=evil.ttf'],
  ])('rejects unsafe font path %s before requesting it', async (unsafePath) => {
    const site = previewSite((path) => {
      if (path === '/_expo/main.js') return javascriptResponse(`module.exports="${unsafePath}";`);
      if (path.startsWith('/assets/') || path.startsWith('/private/')) throw new Error('Unsafe path was fetched');
      return undefined;
    });
    await expect(client(site).smokePreview(42, SHA)).rejects.toThrow('unsafe smoke asset path');
  });

  it('bounds shell downloads even when Content-Length is absent', async () => {
    let canceled = 0;
    const site = previewSite((path) => {
      if (path !== '/') return undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            canceled += 1;
          },
        }),
        { headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } },
      );
    });
    await expect(client(site).smokePreview(42, SHA)).rejects.toThrow('Preview HTML exceeds the smoke byte limit');
    expect(canceled).toBe(24);
  });

  it('rejects unsafe root chunk paths without requesting them', async () => {
    const site = previewSite((path) => {
      if (path !== '/') return undefined;
      return new Response(
        '<link href="/manifest.json"><div id="root"></div><script src="/_expo/../private/main.js"></script>',
        { headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } },
      );
    });
    await expect(client(site).smokePreview(42, SHA)).rejects.toThrow('unsafe smoke asset path');
  });

  it('bounds font discovery before making font requests', async () => {
    const source = Array.from({ length: 33 }, (_, index) => `"/assets/font${index}.ttf"`).join(';');
    const site = previewSite((path) => (path === '/_expo/main.js' ? javascriptResponse(source) : undefined));
    await expect(client(site).smokePreview(42, SHA)).rejects.toThrow('smoke font limit');
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
    ...ICON_FONT_PATHS.map((path) => [path, () => new Response('not found', { status: 404 }), 'Preview font'] as const),
    [
      ICON_FONT_PATHS[0],
      () => new Response('<html>fallback</html>', { headers: { 'content-type': 'font/ttf' } }),
      'not a TrueType/OpenType binary',
    ],
    [
      '/_expo/main.js',
      () => javascriptResponse(`module.exports="${ICON_FONT_PATHS[0]}";`),
      'MaterialSymbols_400Regular icon font reference',
    ],
    [
      '/_expo/main.js',
      () => javascriptResponse('module.exports="https://example.com/MaterialCommunityIcons.ttf";'),
      'MaterialCommunityIcons icon font reference',
    ],
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
