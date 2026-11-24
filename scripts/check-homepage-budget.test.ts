import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { parse } from 'yaml';
import {
  assertHomepageBudget,
  checkHomepageBudget,
  createHomepageFixture,
  parseHomepageBudgetArgs,
} from './check-homepage-budget';
import type { SmokeResponse } from './production-smoke';

const fixture = createHomepageFixture();
const title = 'A fixture homepage';
const completeHtml = `<main><h1>${title}</h1>${fixture.visibleMarkers.map((marker) => `<p>${marker}</p>`).join('')}</main>`;
function response(body = completeHtml): SmokeResponse {
  return { body, status: 200, contentType: 'text/html', headers: {}, url: 'http://127.0.0.1:12345/' };
}

afterEach(() => vi.unstubAllEnvs());

describe('rendered homepage budget assertion', () => {
  it('accepts the complete SSR fixture and exactly the checkout heading', () => {
    expect(assertHomepageBudget(response(), title, fixture.visibleMarkers)).toBeGreaterThan(0);
    expect(() => assertHomepageBudget(response(), 'A different checkout', fixture.visibleMarkers)).toThrow(
      'Expected homepage H1',
    );
  });

  it('uses a stable representative fixture across identical checks', () => {
    expect(createHomepageFixture()).toEqual(createHomepageFixture());
  });

  it('rejects a shell that only carries markers in scripts or attributes', () => {
    const shell = `<main><h1>${title}</h1><p title="${fixture.visibleMarkers.join(' ')}"></p><script>${fixture.visibleMarkers.join(' ')}</script></main>`;
    expect(() => assertHomepageBudget(response(shell), title, fixture.visibleMarkers)).toThrow(
      'visible SSR fixture content',
    );
  });

  it('requires both populated usage proof counts', () => {
    const withoutStats = `<main><h1>${title}</h1>${fixture.visibleMarkers[1]}</main>`;
    expect(() => assertHomepageBudget(response(withoutStats), title, fixture.visibleMarkers)).toThrow('123,400');
  });

  it('rejects poorly compressible HTML exceeding the shared 60,000-byte budget', () => {
    const payload = Array.from({ length: 6000 }, (_, index) =>
      createHash('sha256').update(String(index)).digest('hex'),
    ).join('');
    expect(() =>
      assertHomepageBudget(response(`${completeHtml}<script>${payload}</script>`), title, fixture.visibleMarkers),
    ).toThrow('homepage gzip HTML exceeds 60000 bytes');
  });

  it('rejects redirects and error responses', () => {
    expect(() => assertHomepageBudget({ ...response(), status: 308 }, title, fixture.visibleMarkers)).toThrow(
      'expected HTTP 200',
    );
    expect(() =>
      assertHomepageBudget({ ...response(), contentType: 'application/json' }, title, fixture.visibleMarkers),
    ).toThrow('text/html');
  });

  it('has a normal production-checkout default and explicit artifact override', () => {
    expect(parseHomepageBudgetArgs([])).toBe(resolve('packages/web'));
    expect(parseHomepageBudgetArgs(['--web-dir', '/tmp/built-web'])).toBe('/tmp/built-web');
    expect(() => parseHomepageBudgetArgs(['--build'])).toThrow('Usage:');
  });
});

async function createArtifact(serverSource: string) {
  const directory = await mkdtemp(join(tmpdir(), 'homepage-budget-test-'));
  const webDirectory = join(directory, 'packages/web');
  const standaloneWeb = join(webDirectory, '.next/standalone/packages/web');
  await mkdir(join(standaloneWeb, '.next/cache'), { recursive: true });
  await writeFile(join(webDirectory, '.next/BUILD_ID'), 'fixture-build');
  await writeFile(join(standaloneWeb, '.next/BUILD_ID'), 'fixture-build');
  await writeFile(join(standaloneWeb, '.next/cache/must-not-copy'), 'old cache');
  await writeFile(join(standaloneWeb, '.env.local'), 'PRIVATE_FIXTURE_SECRET=must-not-copy');
  await writeFile(join(standaloneWeb, 'server.js'), serverSource);
  await mkdir(join(directory, 'packages/shared/i18n/locales/en-US'), { recursive: true });
  await writeFile(
    join(directory, 'packages/shared/i18n/locales/en-US/marketing.json'),
    JSON.stringify({ home: { hero: { title } } }),
  );
  return { directory, webDirectory };
}

const successfulServer = `const http = require('node:http');
const fs = require('node:fs');
if (fs.existsSync('.env.local') || fs.existsSync('.next/cache/must-not-copy') || process.env.PRIVATE_FIXTURE_SECRET) throw new Error('isolation failed');
http.createServer(async (_request, response) => {
  const query = async name => (await (await fetch(process.env.BACKEND_INTERNAL_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:'query '+name+' { fixture }'})})).json()).data;
  const stats = await query('GetCommunityStats');
  response.setHeader('Content-Type', 'text/html');
  response.end('<main><h1>A fixture homepage</h1>'+'<p>'+stats.communityStats.climbersLast30Days.toLocaleString('en-US')+' '+stats.communityStats.litLast30Days.toLocaleString('en-US')+'</p></main>');
}).listen(Number(process.env.PORT),process.env.HOSTNAME);`;

describe('isolated artifact runner', () => {
  it('renders populated fixtures, excludes credentials/cache, and cleans its child', async () => {
    const artifact = await createArtifact(successfulServer);
    vi.stubEnv('PRIVATE_FIXTURE_SECRET', 'must-not-inherit');
    try {
      const result = await checkHomepageBudget(artifact.webDirectory);
      expect(result).toMatchObject({
        buildId: 'fixture-build',
        deferredBeta: true,
        expectedHeading: title,
        budgetBytes: 60_000,
      });
      expect(result.gzipBytes).toBeLessThan(60_000);
      expect(await readFile(join(artifact.webDirectory, '.next/standalone/packages/web/.env.local'), 'utf8')).toContain(
        'must-not-copy',
      );
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });

  it('rejects server rendering that fetches privacy-sensitive beta rows', async () => {
    const artifact = await createArtifact(
      successfulServer.replace(
        "const stats = await query('GetCommunityStats');",
        "await query('GetRecentBetaLinks'); const stats = await query('GetCommunityStats');",
      ),
    );
    try {
      await expect(checkHomepageBudget(artifact.webDirectory)).rejects.toThrow(
        'Recent beta must load in the browser, never in cacheable homepage HTML',
      );
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });

  it('fails on a missing artifact instead of building', async () => {
    await expect(checkHomepageBudget('/nonexistent-homepage-budget-artifact')).rejects.toThrow(
      'this checker never builds',
    );
  });

  it('retains startup failure logs and cleans up', async () => {
    const artifact = await createArtifact("console.error('intentional startup failure'); process.exit(7);");
    try {
      await expect(checkHomepageBudget(artifact.webDirectory)).rejects.toThrow('intentional startup failure');
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });

  it('blocks non-fixture socket connections', async () => {
    const artifact = await createArtifact("require('node:net').createConnection({host:'127.0.0.1',port:1});");
    try {
      await expect(checkHomepageBudget(artifact.webDirectory)).rejects.toThrow('HOMEPAGE_BUDGET_BLOCKED_CONNECTION');
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });
});

describe('premerge workflow wiring', () => {
  it('runs after the existing build graph and includes catalog-only changes', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8')) as {
      jobs: { typecheck: { if: string; steps: { name?: string; run?: string; 'timeout-minutes'?: number }[] } };
    };
    const job = workflow.jobs.typecheck;
    expect(job.if).toContain("needs.changes.outputs.i18nCatalogs == 'true'");
    const buildIndex = job.steps.findIndex((step) => step.run === 'vp run typecheck');
    const budgetIndex = job.steps.findIndex((step) => step.run === 'vp exec tsx scripts/check-homepage-budget.ts');
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(budgetIndex).toBeGreaterThan(buildIndex);
    expect(job.steps[budgetIndex]['timeout-minutes']).toBe(2);
  });
});
