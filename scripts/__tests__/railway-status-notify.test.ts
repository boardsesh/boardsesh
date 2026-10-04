import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyIncident,
  formatDiscordContent,
  HEALTH_URL,
  normalizeName,
  parseArgs,
  parseStatusFeed,
  pruneSeen,
  run,
  selectPendingPosts,
  STATUS_API_URL,
  type Fetcher,
  type StatusFeed,
  type StatusIncident,
} from '../railway-status-notify';

const US_WEST = 'US West (California, USA)';
const EU_WEST = 'EU West (Amsterdam, Netherlands)';
const WEBHOOK = 'https://discord.test/webhook';

// Trimmed from the live feed on 2026-10-04, the incident this script exists for.
const storageIncident: StatusIncident = {
  id: 'incident-storage',
  slug: 'A0O39CGE',
  title: 'Slow attached storage for some users in US West',
  status: 'MONITORING',
  components: [{ name: 'Storage', groupName: US_WEST, impact: 'PARTIAL_OUTAGE' }],
  updates: [
    {
      id: 'storage-monitoring',
      status: 'MONITORING',
      createdAt: '2026-10-04T06:08:09.340084+00:00',
      message: 'Storage performance in US West continues to improve.',
    },
    {
      id: 'storage-identified',
      status: 'IDENTIFIED',
      createdAt: '2026-10-04T04:50:09.914788+00:00',
      message: 'We have identified the cause of the storage performance degradation.',
    },
    {
      id: 'storage-investigating',
      status: 'INVESTIGATING',
      createdAt: '2026-10-04T00:34:47.451+00:00',
      message: 'We are aware of an issue affecting attached storage performance for some users in US West.',
    },
  ],
};

const deployIncident: StatusIncident = {
  id: 'incident-deploys',
  slug: 'DEPLOY01',
  title: 'API degradation causing slow or stuck deployments',
  status: 'RESOLVED',
  components: [
    { name: 'API — backboard.railway.com', groupName: 'Railway', impact: 'DEGRADED_PERFORMANCE' },
    { name: 'Deployments', groupName: US_WEST, impact: 'DEGRADED_PERFORMANCE' },
    { name: 'Deployments', groupName: EU_WEST, impact: 'DEGRADED_PERFORMANCE' },
  ],
  updates: [
    { id: 'deploy-resolved', status: 'RESOLVED', createdAt: '2026-09-29T17:00:00+00:00', message: 'Resolved.' },
    { id: 'deploy-investigating', status: 'INVESTIGATING', createdAt: '2026-09-29T15:29:00+00:00', message: 'Slow.' },
  ],
};

const euIncident: StatusIncident = {
  id: 'incident-eu',
  slug: 'EUONLY01',
  title: 'Compute unavailable in EU West',
  status: 'RESOLVED',
  components: [{ name: 'Compute', groupName: EU_WEST, impact: 'MAJOR_OUTAGE' }],
  updates: [{ id: 'eu-resolved', status: 'RESOLVED', createdAt: '2026-09-20T10:00:00+00:00', message: 'Resolved.' }],
};

const operationalIncident: StatusIncident = {
  id: 'incident-operational',
  slug: 'OPERAT01',
  title: 'Potential intermittent connectivity issues',
  status: 'RESOLVED',
  components: [{ name: 'Networking — Public', groupName: US_WEST, impact: 'OPERATIONAL' }],
  updates: [{ id: 'operational-resolved', status: 'RESOLVED', createdAt: '2026-10-02T18:00:00+00:00', message: 'Ok.' }],
};

const unusedComponentIncident: StatusIncident = {
  id: 'incident-buckets',
  slug: 'BUCKET01',
  title: 'Storage bucket creation is degraded',
  status: 'RESOLVED',
  components: [
    { name: 'Storage Buckets', groupName: US_WEST, impact: 'PARTIAL_OUTAGE' },
    { name: 'Builds', groupName: US_WEST, impact: 'DEGRADED_PERFORMANCE' },
  ],
  updates: [{ id: 'buckets-resolved', status: 'RESOLVED', createdAt: '2026-08-31T16:00:00+00:00', message: 'Ok.' }],
};

const feed: StatusFeed = {
  activeIncidents: [storageIncident],
  recentIncidents: [deployIncident, euIncident, operationalIncident, unusedComponentIncident],
};

// Two hours after the storage incident's latest update; the deploy incident is days old.
const NOW_MS = Date.parse('2026-10-04T08:00:00Z');

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function stateFileWith(seenUpdateIds: string[] | null): string {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'railway-status-')), 'seen.json');
  if (seenUpdateIds) writeFileSync(stateFile, JSON.stringify({ seenUpdateIds }));
  return stateFile;
}

function readSeenIds(stateFile: string): string[] {
  return (JSON.parse(readFileSync(stateFile, 'utf8')) as { seenUpdateIds: string[] }).seenUpdateIds;
}

function fakeFetcher(options: { discordStatus?: number; healthStatus?: number } = {}) {
  const discordBodies: string[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    if (url === STATUS_API_URL) return new Response(JSON.stringify(feed), { status: 200 });
    if (url === HEALTH_URL) return new Response(null, { status: options.healthStatus ?? 200 });
    if (url === WEBHOOK) {
      discordBodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(null, { status: options.discordStatus ?? 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetcher, discordBodies };
}

describe('classifyIncident', () => {
  it('treats our region’s storage, compute and networking as user-facing', () => {
    expect(classifyIncident(storageIncident)?.tier).toBe('users');
    for (const name of ['Compute', 'Networking — Public', 'Networking — Private']) {
      const incident = { ...storageIncident, components: [{ name, groupName: US_WEST, impact: 'MAJOR_OUTAGE' }] };
      expect(classifyIncident(incident)?.tier).toBe('users');
    }
  });

  it('treats our region’s deployments, the Railway API and GHCR as deploy-affecting', () => {
    const classification = classifyIncident(deployIncident);
    expect(classification?.tier).toBe('deploys');
    // The EU Deployments row is someone else's problem.
    expect(classification?.components.map((component) => component.groupName)).toEqual(['Railway', US_WEST]);

    const registry = {
      ...deployIncident,
      components: [
        {
          name: 'Image Registry — GitHub (GHCR)',
          groupName: 'External & Third-Party Integrations',
          impact: 'PARTIAL_OUTAGE',
        },
      ],
    };
    expect(classifyIncident(registry)?.tier).toBe('deploys');
  });

  it('lets a user-facing component outrank a deploy one in the same incident', () => {
    const both = { ...deployIncident, components: [...deployIncident.components, ...storageIncident.components] };
    expect(classifyIncident(both)?.tier).toBe('users');
  });

  it('ignores other regions, OPERATIONAL impact, and components we do not run on', () => {
    expect(classifyIncident(euIncident)).toBeNull();
    expect(classifyIncident(operationalIncident)).toBeNull();
    expect(classifyIncident(unusedComponentIncident)).toBeNull();
  });

  it('matches component names whatever dash the feed uses', () => {
    expect(normalizeName('Networking — Public')).toBe('networking - public');
    expect(normalizeName('Networking  -  Public')).toBe('networking - public');
  });
});

describe('selectPendingPosts', () => {
  it('posts every unseen update of a relevant incident, oldest first', () => {
    const { posts } = selectPendingPosts(
      feed,
      ['storage-investigating', 'deploy-investigating', 'deploy-resolved'],
      NOW_MS,
    );
    expect(posts.map((post) => post.update.id)).toEqual(['storage-identified', 'storage-monitoring']);
  });

  it('posts nothing once everything is seen', () => {
    const everyId = [...storageIncident.updates, ...deployIncident.updates].map((update) => update.id);
    expect(selectPendingPosts(feed, everyId, NOW_MS).posts).toEqual([]);
  });

  it('records an unseen update older than a day instead of posting it', () => {
    const { posts, alreadySeen } = selectPendingPosts(feed, [], NOW_MS);
    expect(posts.map((post) => post.update.id)).toEqual([
      'storage-investigating',
      'storage-identified',
      'storage-monitoring',
    ]);
    expect(alreadySeen).toEqual(['deploy-resolved', 'deploy-investigating']);
  });

  it('posts an incident listed as both active and recent once', () => {
    const { posts } = selectPendingPosts(
      { activeIncidents: [storageIncident], recentIncidents: [storageIncident] },
      ['storage-investigating', 'storage-identified'],
      NOW_MS,
    );
    expect(posts.map((post) => post.update.id)).toEqual(['storage-monitoring']);
  });

  it('with no stored state, posts only the latest update of an open incident', () => {
    const { posts, alreadySeen } = selectPendingPosts(feed, null, NOW_MS);
    expect(posts.map((post) => post.update.id)).toEqual(['storage-monitoring']);
    expect(new Set(alreadySeen)).toEqual(
      new Set(['deploy-investigating', 'deploy-resolved', 'storage-identified', 'storage-investigating']),
    );
  });
});

describe('formatDiscordContent', () => {
  it('names the incident, the component, the health probe and the incident page', () => {
    const [post] = selectPendingPosts(feed, null, NOW_MS).posts;
    const content = formatDiscordContent(post, { ok: false, detail: 'failing (503)' });
    expect(content.split('\n')).toEqual([
      '🚨 Railway incident likely affecting Boardsesh',
      '**Slow attached storage for some users in US West** — Monitoring',
      'Storage (US West): partial outage',
      '> Storage performance in US West continues to improve.',
      'Boardsesh database health right now: failing (503)',
      '<https://status.railway.com/incident/A0O39CGE>',
    ]);
  });

  it('labels deploy-only incidents and resolutions differently', () => {
    const [investigating, resolved] = selectPendingPosts(
      { activeIncidents: [], recentIncidents: [deployIncident] },
      [],
      Date.parse('2026-09-29T18:00:00Z'),
    ).posts;
    expect(formatDiscordContent(investigating, null)).toContain('🟡 Railway incident may stall deploys');
    expect(formatDiscordContent(investigating, null)).toContain(
      'API — backboard.railway.com (Railway): degraded performance · Deployments (US West): degraded performance',
    );
    expect(formatDiscordContent(resolved, null).startsWith('✅ Railway resolved an incident')).toBe(true);
  });

  it('keeps a quoted update to one blockquote level', () => {
    const [post] = selectPendingPosts(feed, null, NOW_MS).posts;
    const quoted = { ...post, update: { ...post.update, message: '> > Storage is `slow`.\nStill.' } };
    expect(formatDiscordContent(quoted, null)).toContain("\n> Storage is 'slow'. Still.\n");
  });

  it('keeps a long update inside Discord’s 2000-character cap', () => {
    const [post] = selectPendingPosts(feed, null, NOW_MS).posts;
    const longPost = { ...post, update: { ...post.update, message: 'storage '.repeat(2000) } };
    const content = formatDiscordContent(longPost, null);
    expect(content.length).toBeLessThan(700);
    expect(content).toContain('<https://status.railway.com/incident/A0O39CGE>');
  });
});

describe('parseStatusFeed', () => {
  it('throws on a shape change instead of reading it as "no incidents"', () => {
    expect(() => parseStatusFeed({ recentIncidents: [] })).toThrow(/activeIncidents/);
    expect(() =>
      parseStatusFeed({ activeIncidents: [{ ...storageIncident, updates: undefined }], recentIncidents: [] }),
    ).toThrow(/updates/);
  });

  it('throws on a timestamp it cannot read, which the age rule would otherwise drop', () => {
    const badUpdate = { ...storageIncident.updates[0], createdAt: 'yesterday' };
    expect(() =>
      parseStatusFeed({ activeIncidents: [{ ...storageIncident, updates: [badUpdate] }], recentIncidents: [] }),
    ).toThrow(/createdAt is not a timestamp/);
  });

  it('accepts a component with no group', () => {
    const parsed = parseStatusFeed({
      activeIncidents: [{ ...storageIncident, components: [{ name: 'Payments & Billing', impact: 'MAJOR_OUTAGE' }] }],
      recentIncidents: [],
    });
    expect(parsed.activeIncidents[0].components[0].groupName).toBe('');
  });
});

describe('run', () => {
  it('posts unseen updates, stores them as seen, and blocks mentions', async () => {
    const stateFile = stateFileWith(['storage-investigating', 'deploy-investigating', 'deploy-resolved']);
    const { fetcher, discordBodies } = fakeFetcher({ healthStatus: 503 });

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 2, failed: 0, changed: true });
    expect(discordBodies).toHaveLength(2);
    const firstBody = JSON.parse(discordBodies[0]) as { content: string; allowed_mentions: { parse: string[] } };
    expect(firstBody.allowed_mentions).toEqual({ parse: [] });
    expect(firstBody.content).toContain('failing (503)');
    expect(readSeenIds(stateFile)).toEqual(expect.arrayContaining(['storage-identified', 'storage-monitoring']));

    const secondRun = fakeFetcher();
    const repeat = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher: secondRun.fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });
    expect(repeat).toEqual({ posted: 0, failed: 0, changed: false });
    expect(secondRun.discordBodies).toEqual([]);
  });

  it('leaves an update unseen when Discord rejects it, so the next run retries', async () => {
    const seenBefore = ['storage-investigating', 'storage-identified', 'deploy-investigating', 'deploy-resolved'];
    const stateFile = stateFileWith(seenBefore);
    const { fetcher } = fakeFetcher({ discordStatus: 429 });

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 0, failed: 1, changed: false });
    expect(readSeenIds(stateFile)).toEqual(seenBefore);
  });

  it('seeds the state on a cache miss without replaying old incidents', async () => {
    const stateFile = stateFileWith(null);
    const { fetcher, discordBodies } = fakeFetcher();

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 1, failed: 0, changed: true });
    expect(discordBodies).toHaveLength(1);
    expect(readSeenIds(stateFile)).toHaveLength(5);
  });

  it('keeps the posts that landed when a later one fails', async () => {
    const stateFile = stateFileWith(['deploy-investigating', 'deploy-resolved']);
    let discordCalls = 0;
    const fetcher: Fetcher = async (input) => {
      const url = String(input);
      if (url === STATUS_API_URL) return new Response(JSON.stringify(feed), { status: 200 });
      if (url === HEALTH_URL) return new Response(null, { status: 200 });
      discordCalls += 1;
      return new Response(null, { status: discordCalls === 3 ? 500 : 204 });
    };

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 2, failed: 1, changed: true });
    expect(readSeenIds(stateFile)).toEqual([
      'deploy-investigating',
      'deploy-resolved',
      'storage-investigating',
      'storage-identified',
    ]);
  });

  it('fails the run when there is something to post and no webhook', async () => {
    const seenBefore = ['storage-investigating', 'storage-identified', 'deploy-investigating', 'deploy-resolved'];
    const stateFile = stateFileWith(seenBefore);
    const { fetcher } = fakeFetcher();

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: undefined,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 0, failed: 1, changed: false });
    expect(readSeenIds(stateFile)).toEqual(seenBefore);
  });

  it('holds anything past 5 posts for the next run', async () => {
    const manyUpdates = Array.from({ length: 7 }, (_, index) => ({
      id: `burst-${index}`,
      status: 'MONITORING',
      createdAt: `2026-10-04T07:0${index}:00+00:00`,
      message: `Update ${index}`,
    }));
    const burstFeed = { activeIncidents: [{ ...storageIncident, updates: manyUpdates }], recentIncidents: [] };
    const stateFile = stateFileWith([]);
    const discordBodies: string[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = String(input);
      if (url === STATUS_API_URL) return new Response(JSON.stringify(burstFeed), { status: 200 });
      if (url === HEALTH_URL) return new Response(null, { status: 200 });
      discordBodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(null, { status: 204 });
    };

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 5, failed: 0, changed: true });
    expect(readSeenIds(stateFile)).toEqual(['burst-0', 'burst-1', 'burst-2', 'burst-3', 'burst-4']);
  });

  it('treats a truncated state file as no state, not as an empty list', async () => {
    const stateFile = stateFileWith(null);
    writeFileSync(stateFile, '{"seenUpdateIds": ["storage-inv');
    const { fetcher, discordBodies } = fakeFetcher();

    const result = await run({
      stateFile,
      dryRun: false,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    // The cache-miss path: one post for the open incident, not all three of its updates.
    expect(result).toEqual({ posted: 1, failed: 0, changed: true });
    expect(discordBodies).toHaveLength(1);
  });

  it('posts nothing and writes nothing on a dry run', async () => {
    const stateFile = stateFileWith([]);
    const { fetcher, discordBodies } = fakeFetcher();

    const result = await run({
      stateFile,
      dryRun: true,
      webhookUrl: WEBHOOK,
      fetcher,
      logger: silentLogger,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ posted: 0, failed: 0, changed: false });
    expect(discordBodies).toEqual([]);
    expect(readSeenIds(stateFile)).toEqual([]);
  });
});

describe('pruneSeen and parseArgs', () => {
  it('keeps the newest 500 IDs and drops duplicates', () => {
    const ids = Array.from({ length: 600 }, (_, index) => `update-${index}`);
    const pruned = pruneSeen([...ids, 'update-599']);
    expect(pruned).toHaveLength(500);
    expect(pruned.at(0)).toBe('update-100');
    expect(pruned.at(-1)).toBe('update-599');
  });

  it('reads the flags and rejects unknown ones', () => {
    expect(parseArgs(['--dry-run', '--state-file', 'seen.json'])).toEqual({ stateFile: 'seen.json', dryRun: true });
    expect(() => parseArgs(['--apply'])).toThrow(/Unknown argument/);
  });
});
