import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkWebOriginCompatibility } from '../web-origin-compatibility';
import type { RetainedAssetFetch } from '../retained-next-assets-smoke';

const serviceId = '10000000-0000-4000-8000-000000000001';
const projectId = '20000000-0000-4000-8000-000000000002';
const environmentId = '30000000-0000-4000-8000-000000000003';
const deploymentId = '40000000-0000-4000-8000-000000000004';
const otherId = '50000000-0000-4000-8000-000000000005';
const expectedImage = 'ghcr.io/boardsesh/web:production';
const release = 'a'.repeat(40);
const base = 'https://web-fixture.up.railway.app';
const token = 'private-test-project-token';
const options = { base, serviceId, expectedImage, token };
const retainedPath = '/_next/static/Sj_peyg3dLRKbogd1hG-t/_buildManifest.js';
const manifest = readFileSync(new URL('./fixtures/retained-next-build-manifest.js.txt', import.meta.url), 'utf8');

function candidate() {
  return {
    id: deploymentId,
    serviceId,
    environmentId,
    projectId,
    meta: { image: expectedImage },
    canRollback: true,
    createdAt: '2026-09-01T12:00:00Z',
    status: 'SUCCESS',
  };
}

function snapshot() {
  return { latest: candidate(), active: [candidate()], list: [candidate()], sourceImage: expectedImage };
}

function newer(status: string) {
  return { ...candidate(), id: otherId, status, createdAt: '2026-09-01T13:00:00Z' };
}

type Snapshot = ReturnType<typeof snapshot>;

function requests(
  before: Snapshot,
  after = structuredClone(before),
  health = {
    status: 'ok',
    deploymentId,
    release,
    staticAssets: { retainedNextAssets: true },
  },
  asset = manifest,
) {
  let reads = 0;
  const fetchImpl = vi.fn<RetainedAssetFetch>(async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (url.origin === 'https://backboard.railway.com') {
      expect(url.pathname).toBe('/graphql/v2');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(headers.get('Project-Access-Token')).toBe(token);
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON GraphQL request');
      const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      expect(body.query.trim()).toMatch(/^query /);
      if (body.query.includes('ProjectTokenScopeForVerifiedRollback')) {
        reads++;
        return Response.json({ data: { projectToken: { projectId, environmentId } } });
      }
      const state = reads === 1 ? before : after;
      if (body.query.includes('ServiceInstanceStateForVerifiedRollback')) {
        expect(body.variables).toEqual({ environmentId, serviceId });
        return Response.json({
          data: {
            serviceInstance: {
              source: { image: state.sourceImage },
              activeDeployments: state.active,
              latestDeployment: state.latest,
            },
          },
        });
      }
      expect(body.query).toContain('ServiceDeploymentsForVerifiedRollback');
      expect(body.variables).toEqual({
        first: 100,
        input: { serviceId, projectId, environmentId, includeDeleted: true },
      });
      return Response.json({ data: { deployments: { edges: state.list.map((node) => ({ node })) } } });
    }
    expect(headers.has('Project-Access-Token')).toBe(false);
    expect(init?.headers).toBeUndefined();
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('manual');
    if (url.href === base + '/api/health') return Response.json(health, { headers: { 'cache-control': 'no-store' } });
    if (url.origin === base && url.pathname === retainedPath) {
      return new Response(null, {
        status: 307,
        headers: {
          location: 'https://assets.boardsesh.com' + retainedPath,
          'cache-control': 'no-store',
          'cdn-cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        },
      });
    }
    expect(url.href).toBe('https://assets.boardsesh.com' + retainedPath);
    return new Response(asset, {
      headers: {
        'content-type': 'application/javascript',
        'cache-control': 'public, immutable, max-age=31536000',
        'access-control-allow-origin': '*',
      },
    });
  });
  return fetchImpl;
}

describe('web origin compatibility', () => {
  it.each(['SUCCESS', 'FAILED', 'CANCELED'])(
    'proves the exact serving rollback candidate with latest %s',
    async (status) => {
      const state = snapshot();
      if (status !== 'SUCCESS') {
        state.latest = newer(status);
        state.list.push(state.latest);
      }
      const fetchImpl = requests(state);
      await expect(
        checkWebOriginCompatibility({
          ...options,
          expectedDeploymentId: deploymentId,
          expectedRelease: release,
          fetchImpl,
        }),
      ).resolves.toEqual({ deploymentId, release });
      expect(fetchImpl).toHaveBeenCalledTimes(10);
    },
  );

  it.each<[string, (state: Snapshot) => void]>([
    [
      'another configured image',
      (state) => {
        state.sourceImage = 'another';
      },
    ],
    [
      'another running image',
      (state) => {
        state.active[0].meta.image = 'another';
      },
    ],
    [
      'a deployment in another service',
      (state) => {
        state.list[0].serviceId = otherId;
      },
    ],
    [
      'a deployment in another environment',
      (state) => {
        state.latest.environmentId = otherId;
      },
    ],
    [
      'a deployment in another project',
      (state) => {
        state.active[0].projectId = otherId;
      },
    ],
    [
      'another active deployment',
      (state) => {
        state.active.push(newer('SUCCESS'));
      },
    ],
    [
      'a non-rollbackable serving instance',
      (state) => {
        state.active[0].canRollback = false;
      },
    ],
    [
      'inconsistent rollback capability',
      (state) => {
        state.list[0].canRollback = false;
      },
    ],
    [
      'an unrecognized status',
      (state) => {
        state.list[0].status = 'UNSUPPORTED';
      },
    ],
    [
      'a pending deployment',
      (state) => {
        state.list.push(newer('QUEUED'));
      },
    ],
    [
      'a missing candidate',
      (state) => {
        state.list = [];
      },
    ],
    [
      'an unlisted latest',
      (state) => {
        state.latest = newer('FAILED');
      },
    ],
    [
      'competing success',
      (state) => {
        state.latest = newer('SUCCESS');
        state.list.push(state.latest);
      },
    ],
    [
      'ties for newest',
      (state) => {
        state.list.push({ ...candidate(), id: otherId });
      },
    ],
  ])('rejects %s before requesting the public asset', async (_reason, mutate) => {
    const state = snapshot();
    mutate(state);
    const fetchImpl = requests(state);
    await expect(checkWebOriginCompatibility({ ...options, fetchImpl })).rejects.toThrow();
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url).hostname === 'backboard.railway.com')).toBe(true);
  });

  it.each(['deploymentId', 'release', 'capability', 'digest', 'noncommit'])(
    'rejects a failed %s proof',
    async (fault) => {
      const health = {
        status: 'ok',
        deploymentId: fault === 'deploymentId' ? otherId : deploymentId,
        release: fault === 'noncommit' ? 'development' : release,
        staticAssets: { retainedNextAssets: fault !== 'capability' },
      };
      const fetchImpl = requests(snapshot(), snapshot(), health, fault === 'digest' ? 'x'.repeat(1106) : manifest);
      await expect(
        checkWebOriginCompatibility({
          ...options,
          fetchImpl,
          expectedRelease: fault === 'release' ? 'b'.repeat(40) : undefined,
        }),
      ).rejects.toThrow();
    },
  );

  it('fences a stale previous ID even when platform and health agree', async () => {
    const fetchImpl = requests(snapshot());
    await expect(checkWebOriginCompatibility({ ...options, fetchImpl, expectedDeploymentId: otherId })).rejects.toThrow(
      'captured previous',
    );
  });

  it.each(['active changed', 'later failure', 'configured image changed'])(
    'rejects %s during the proof',
    async (fault) => {
      const after = snapshot();
      if (fault === 'active changed') {
        after.latest = newer('SUCCESS');
        after.active = [after.latest];
        after.list = [after.latest];
      } else if (fault === 'later failure') {
        after.latest = newer('FAILED');
        after.list.push(after.latest);
      } else {
        after.sourceImage = 'another';
      }
      await expect(
        checkWebOriginCompatibility({ ...options, fetchImpl: requests(snapshot(), after) }),
      ).rejects.toThrow();
    },
  );

  it('requires a direct Railway origin before reading the token scope', async () => {
    const fetchImpl = requests(snapshot());
    await expect(
      checkWebOriginCompatibility({ ...options, base: 'https://www.boardsesh.com', fetchImpl }),
    ).rejects.toThrow('direct https');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits private GraphQL errors from diagnostics', async () => {
    const fetchImpl = vi.fn<RetainedAssetFetch>().mockResolvedValue(Response.json({ errors: [{ message: token }] }));
    await expect(checkWebOriginCompatibility({ ...options, fetchImpl })).rejects.toThrow('returned GraphQL errors');
  });
});
