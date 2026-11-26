/// <reference types="node" />
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readBounded } from './retained-next-assets-smoke.ts';

type AssetFetch = (input: URL, init: RequestInit) => Promise<Response>;
type AssetKind = 'script' | 'stylesheet';

const HTML_LIMIT = 2 * 1024 * 1024;
const ASSET_LIMIT = 4 * 1024 * 1024;

// Next emits ordinary HTML attributes and escapes query separators as &amp;.
// Skip comments and raw text so Flight strings and script bodies cannot supply a tag.
function documentAssets(html: string, page: URL, release: string) {
  const tags =
    /<!--[\s\S]*?-->|<(script|style|title|textarea|noscript|template)\b((?:"[^"]*"|'[^']*'|[^'">])*)>[\s\S]*?<\/\1\s*>|<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  const assets: Record<AssetKind, Set<string>> = { script: new Set(), stylesheet: new Set() };
  const references: { tag: string; address: string; legacyScript: boolean; rel?: string; as?: string }[] = [];
  let base: URL | undefined;
  let releaseCount = 0;
  for (const match of html.matchAll(tags)) {
    const tag = (match[1] ?? match[3])?.toLowerCase();
    if (!['script', 'link', 'meta', 'base'].includes(tag)) continue;
    const attributes = new Map<string, string>();
    for (const attribute of (match[2] ?? match[4]).matchAll(
      /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    )) {
      const name = attribute[1].toLowerCase();
      if (!attributes.has(name))
        attributes.set(name, (attribute[2] ?? attribute[3] ?? attribute[4] ?? '').replace(/&amp;/gi, '&'));
    }
    if (tag === 'meta' && attributes.get('name') === 'boardsesh-release') {
      assert(attributes.get('content') === release, page.pathname + ' has the wrong build release');
      releaseCount++;
    }
    const address = attributes.get(tag === 'script' ? 'src' : 'href');
    if (address === undefined) continue;
    if (tag === 'base' && !base) base = new URL(address, page);
    if (tag === 'script' || tag === 'link') {
      references.push({
        tag,
        address,
        legacyScript: attributes.has('nomodule'),
        rel: attributes.get('rel'),
        as: attributes.get('as'),
      });
    }
  }
  assert(releaseCount === 1, page.pathname + ' must declare one build release');
  for (const { tag, address, legacyScript, rel, as } of references) {
    const url = new URL(address, base ?? page);
    if (!url.pathname.startsWith('/_next/static/')) continue;
    assert(
      url.origin === page.origin && !url.username && !url.password,
      page.pathname + ' references a Next asset outside its origin',
    );
    if (tag === 'script') {
      if (!legacyScript) assets.script.add(url.href);
    } else if (
      url.pathname.endsWith('.css') ||
      rel?.toLowerCase().split(/\s+/).includes('stylesheet') ||
      as?.toLowerCase() === 'style'
    ) {
      assets.stylesheet.add(url.href);
    }
  }
  assert(assets.script.size > 0, page.pathname + ' has no current Next script');
  return assets;
}

export async function checkCurrentNextAssets(
  base: string,
  expectedRelease: string,
  fetchImpl: AssetFetch = fetch,
): Promise<void> {
  assert(/^[0-9a-f]{40}$/i.test(expectedRelease), 'Expected a full release SHA');
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

  async function checkedBody(response: Response, kind: AssetKind | 'document', label: string) {
    assert(
      response.status === 200 && !response.redirected && !response.headers.has('location'),
      label + ' must return a direct 200',
    );
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (kind === 'document') {
      assert(mime === 'text/html', label + ' must be HTML');
      return await readBounded(response, HTML_LIMIT);
    }
    const validMime =
      kind === 'script' ? mime === 'application/javascript' || mime === 'text/javascript' : mime === 'text/css';
    assert(validMime, label + ' has an unexpected MIME type');
    const directives = (response.headers.get('cache-control') ?? '')
      .toLowerCase()
      .split(',')
      .map((entry) => entry.trim());
    assert(
      directives.includes('public') &&
        directives.includes('immutable') &&
        directives.filter((entry) => entry.startsWith('max-age=')).join(',') === 'max-age=31536000' &&
        !directives.some((entry) => /^(private|no-store|no-cache)(?:=|$)/.test(entry)),
      label + ' must be public and immutable for one year',
    );
    const bytes = await readBounded(response, ASSET_LIMIT);
    assert(bytes.length > 0, label + ' has an empty body');
    return bytes;
  }

  async function get(url: URL, kind: AssetKind | 'document', route: string) {
    const signal = AbortSignal.timeout(30_000);
    const label = route + ' ' + kind;
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          signal,
        });
        if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
          return await checkedBody(response, kind, label);
        }
      } catch (error) {
        // Fetch and interrupted body reads surface network errors as TypeError.
        if (!(error instanceof TypeError) || attempt === 3 || signal.aborted) throw error;
      } finally {
        // An interrupted stream also rejects cancel(); preserve the original read outcome.
        await response?.body?.cancel().catch(() => undefined);
      }
      await sleep(3_000, undefined, { signal });
    }
  }

  const advertised = new Set<string>();
  for (const route of ['/', '/apps/kilter']) {
    const page = new URL(route, origin);
    const html = await get(page, 'document', route);
    const assets = documentAssets(html.toString('utf8'), page, expectedRelease);
    for (const kind of ['script', 'stylesheet'] as const) {
      const choices = [...assets[kind]].reverse();
      const address = choices.find((choice) => !advertised.has(choice)) ?? choices[0];
      if (address) {
        await get(new URL(address), kind, route);
        for (const choice of choices) advertised.add(choice);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { base: { type: 'string' } } });
  checkCurrentNextAssets(values.base ?? '', process.env.SMOKE_EXPECTED_RELEASE ?? '').then(
    () => console.log('Current Next scripts and styles verified on Home and Kilter'),
    (error: unknown) => {
      console.error(
        error instanceof assert.AssertionError ? error.message : 'Current Next assets smoke request failed',
      );
      process.exitCode = 1;
    },
  );
}
