/// <reference types="node" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// This release-specific manifest is published permanently, but absent from later images.
const RETAINED_PATH = '/_next/static/Sj_peyg3dLRKbogd1hG-t/_buildManifest.js';
const RETAINED_URL = 'https://assets.boardsesh.com' + RETAINED_PATH;
const DECODED_BYTES = 1106;
const DECODED_SHA256 = 'f0722beec8ce9d306099e34857656208a0c6b57f6ff6fcfee239a753319d753e';

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  assert(response.body, 'Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= limit, 'Response exceeds expected size');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

type ExpectedDeployment = { deploymentId?: string; release?: string };
export type RetainedAssetFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export async function checkRetainedNextAssets(
  base: string,
  expected: ExpectedDeployment = {},
  fetchImpl: RetainedAssetFetch = fetch,
): Promise<{ deploymentId: string; release: string }> {
  const origin = new URL(base);
  assert(
    ['https:', 'http:'].includes(origin.protocol) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash,
    'Expected a web origin',
  );

  async function get<T>(url: URL | string, inspect: (response: Response) => Promise<T>): Promise<T> {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    try {
      return await inspect(response);
    } finally {
      await response.body?.cancel();
    }
  }

  function readDeployment() {
    return get(new URL('/api/health', origin), async (response) => {
      assert.equal(response.status, 200, 'Health response status');
      assert(
        /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''),
        'Health must be uncached',
      );
      const health: unknown = JSON.parse((await readBounded(response, 16_384)).toString('utf8'));
      assert(isRecord(health) && health.status === 'ok', 'Unhealthy web deployment');
      assert(
        isRecord(health.staticAssets) && health.staticAssets.retainedNextAssets === true,
        'Missing retained asset capability',
      );
      function checkedIdentity(key: keyof ExpectedDeployment, actual: unknown): string {
        assert(typeof actual === 'string' && actual.trim() && actual !== 'unknown', 'Missing health ' + key);
        if (expected[key] !== undefined) assert.equal(actual, expected[key], 'Unexpected ' + key);
        return actual;
      }
      return {
        deploymentId: checkedIdentity('deploymentId', health.deploymentId),
        release: checkedIdentity('release', health.release),
      };
    });
  }

  const initial = await readDeployment();
  await get(new URL(RETAINED_PATH + '?smoke=retained', origin), async (response) => {
    assert.equal(response.status, 307, 'Expected a retained-only redirect');
    assert.equal(response.headers.get('location'), RETAINED_URL, 'Expected a fixed, query-free CDN URL');
    for (const header of ['cache-control', 'cdn-cache-control']) {
      assert(
        /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get(header) ?? ''),
        'Redirect requires no-store ' + header,
      );
    }
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', 'Redirect referrer policy');
  });
  await get(RETAINED_URL, async (response) => {
    assert.equal(response.status, 200, 'Retained CDN response status');
    assert.equal(response.headers.get('access-control-allow-origin'), '*', 'Expected anonymous cross-origin access');
    assert(
      /^(?:application|text)\/javascript(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''),
      'Expected JavaScript',
    );
    const directives = (response.headers.get('cache-control') ?? '')
      .toLowerCase()
      .split(',')
      .map((part) => part.trim());
    assert(
      directives.includes('public') &&
        directives.includes('immutable') &&
        directives.includes('max-age=31536000') &&
        !directives.some((directive) => ['private', 'no-cache', 'no-store'].includes(directive)),
      'Expected public immutable caching',
    );
    const bytes = await readBounded(response, DECODED_BYTES);
    assert.equal(bytes.length, DECODED_BYTES, 'Retained decoded size');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), DECODED_SHA256, 'Retained decoded SHA-256');
  });
  assert.deepEqual(await readDeployment(), initial, 'Deployment changed during the retained asset check');
  return initial;
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'https://www.boardsesh.com' } } });
  const expected = {
    deploymentId: process.env.SMOKE_EXPECTED_DEPLOYMENT_ID,
    release: process.env.SMOKE_EXPECTED_RELEASE,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      await checkRetainedNextAssets(values.base, expected);
      console.log('Retained Next.js asset redirect, bytes and deployment identity verified');
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn('Retrying retained asset check:', error instanceof Error ? error.message : 'request failed');
      await sleep(3_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Retained asset smoke failed');
    process.exitCode = 1;
  });
}
