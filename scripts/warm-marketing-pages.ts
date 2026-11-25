#!/usr/bin/env node
/// <reference types="node" />

import { pathToFileURL } from 'node:url';
import { MARKETING_CACHE_PATHS } from '../packages/web/app/lib/marketing-page-cache.ts';

/** Exact anonymous documents only. No credentials, query strings or router requests. */
export const MARKETING_WARM_PATHS = MARKETING_CACHE_PATHS;

const MAX_DOCUMENT_BYTES = 2_000_000;

async function readDocument(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing document body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds warm-up size limit');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}

/** Warming reaches this runner's edge; it does not prepopulate every Cloudflare location. */
export async function warmMarketingPages(expectedRelease: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(expectedRelease)) throw new Error('Expected a full release SHA');
  const origin = 'https://www.boardsesh.com';
  const health = await fetchImpl(`${origin}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!health.ok) throw new Error(`Release check returned ${health.status}`);
  const identity: unknown = JSON.parse(await readDocument(health));
  if (!identity || typeof identity !== 'object' || !('release' in identity) || identity.release !== expectedRelease) {
    throw new Error('Public origin is not serving the deployed release; skipping warm-up');
  }
  for (const pathname of MARKETING_WARM_PATHS) {
    for (let pass = 1; pass <= 2; pass++) {
      const response = await fetchImpl(`${origin}${pathname}`, {
        redirect: 'error',
        headers: {
          Accept: 'text/html',
          'User-Agent': 'Boardsesh-Deployment-Warmup/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const cacheControl = response.headers.get('cache-control') ?? '';
      const sharedPolicy =
        response.headers.get('cloudflare-cdn-cache-control') ??
        response.headers.get('cdn-cache-control') ??
        cacheControl;
      if (response.status !== 200 || !contentType.includes('text/html') || response.headers.has('set-cookie')) {
        await response.body?.cancel();
        throw new Error(`Unexpected document response at ${pathname}: ${response.status}`);
      }
      const html = await readDocument(response);
      const sharedTtl = Number(sharedPolicy.match(/(?:^|,)\s*s-maxage=(\d+)/i)?.[1] ?? 0);
      if (!/<h1[\s>]/i.test(html) || sharedTtl <= 0 || /private|no-store/i.test(sharedPolicy)) {
        throw new Error(`Document at ${pathname} is missing content or shared caching`);
      }
      const releaseMeta = html.match(/<meta\b[^>]*\bname=["']boardsesh-release["'][^>]*>/i)?.[0];
      const documentRelease = releaseMeta?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
      if (documentRelease !== expectedRelease) {
        console.warn(`${pathname}: skipped stale or unstamped edge document; let its existing TTL expire`);
        break;
      }
      console.log(`${pathname} pass ${pass}: ${response.headers.get('cf-cache-status') ?? 'unknown'}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  warmMarketingPages(process.env.SMOKE_EXPECTED_RELEASE ?? '').catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Marketing warm-up failed');
    process.exitCode = 1;
  });
}
