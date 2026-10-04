#!/usr/bin/env tsx
/// <reference types="node" />

/**
 * Railway status page -> Discord.
 *
 * On 2026-10-03 a Railway US West storage incident made /graphql time out for
 * 6.7 hours. We heard about it from a climber, and spent an investigation ruling
 * out our own code before anyone opened Railway's status page. This posts each
 * update of a Railway incident that touches what we run, so the next one starts
 * with the answer.
 *
 * It explains an outage; it does not detect one. Railway's first update for that
 * incident was stamped an hour after our timeouts began. Sentry uptime on
 * /health/db stays the first alarm.
 *
 *   vp run railway:status-notify -- --dry-run
 *   vp run railway:status-notify -- --state-file .boardsesh/railway-status-seen.json
 *
 * The cron runs this with plain `node` (type stripping) and no `vp install`, so
 * it may import node: builtins only. See docs/railway-status-alerts.md.
 *
 * Env: DISCORD_DEPLOY_WEBHOOK (absent with something to post = print, leave it unseen, exit 1),
 * GITHUB_OUTPUT (optional; receives `changed=true|false` for the cache step).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUS_API_URL = 'https://status.railway.com/api/status';
export const INCIDENT_PAGE_BASE = 'https://status.railway.com/incident';
export const HEALTH_URL = 'https://ws.boardsesh.com/health/db';

/** Hard cap Discord enforces on a message body; it drops the whole POST above it. */
const DISCORD_MESSAGE_LIMIT = 2000;
const UPDATE_EXCERPT_LIMIT = 300;
/** Seen-ID ceiling. Railway's feed carries ~3 months, about 110 updates. */
const SEEN_LIMIT = 500;
/** One incident can post several updates between runs; more than this is a flood. */
const MAX_POSTS_PER_RUN = 5;
/**
 * An unseen update older than this is recorded, not posted. It bounds the damage
 * of a seen-list that came back empty or stale: a day of updates at most, never
 * the three months the feed carries.
 */
const MAX_UPDATE_AGE_MS = 24 * 60 * 60 * 1000;
/** Discord message flag: no link previews, for the URLs Railway writes into its updates. */
const SUPPRESS_EMBEDS = 4;
const FETCH_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 10_000;

/** Every Boardsesh service runs in Railway's us-west2. */
const OUR_REGION_PREFIX = 'US West';

/**
 * Components whose failure breaks the app for climbers: the containers, the
 * Postgres volume, and the network between and in front of them. Names are
 * compared after `normalizeName`, so the feed's em dashes are written as `-`.
 */
export const USER_FACING_REGION_COMPONENTS: ReadonlySet<string> = new Set([
  'compute',
  'storage',
  'networking - public',
  'networking - private',
]);

/** In our region, a failure here stalls a deploy but leaves the running app alone. */
export const DEPLOY_REGION_COMPONENTS: ReadonlySet<string> = new Set(['deployments']);

/** Region-less components every deploy goes through: Railway's API and the registry our images live in. */
export const DEPLOY_GLOBAL_COMPONENTS: ReadonlySet<string> = new Set([
  'api - backboard.railway.com',
  'image registry - github (ghcr)',
]);

export type Tier = 'users' | 'deploys';

export type StatusComponent = { name: string; groupName: string; impact: string };
export type StatusUpdate = { id: string; status: string; createdAt: string; message: string };
export type StatusIncident = {
  id: string;
  slug: string;
  title: string;
  status: string;
  components: StatusComponent[];
  updates: StatusUpdate[];
};
export type StatusFeed = { activeIncidents: StatusIncident[]; recentIncidents: StatusIncident[] };

export type PendingPost = {
  incident: StatusIncident;
  update: StatusUpdate;
  tier: Tier;
  /** The incident's components that matched our rules, for the message. */
  components: StatusComponent[];
};
export type HealthProbe = { ok: boolean; detail: string };

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Logger = Pick<Console, 'error' | 'log' | 'warn'>;

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const field = source[key];
  if (typeof field !== 'string') throw new Error(`Railway status feed: ${where}.${key} is not a string`);
  return field;
}

function requireTimestamp(source: Record<string, unknown>, key: string, where: string): string {
  const field = requireString(source, key, where);
  // The 24-hour age rule compares on this; NaN would read as "stale" and drop the update unposted.
  if (Number.isNaN(Date.parse(field))) throw new Error(`Railway status feed: ${where}.${key} is not a timestamp`);
  return field;
}

function requireArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const field = source[key];
  if (!Array.isArray(field)) throw new Error(`Railway status feed: ${where}.${key} is not an array`);
  return field;
}

function parseIncident(raw: unknown, where: string): StatusIncident {
  if (!isRecord(raw)) throw new Error(`Railway status feed: ${where} is not an object`);
  return {
    id: requireString(raw, 'id', where),
    slug: requireString(raw, 'slug', where),
    title: requireString(raw, 'title', where),
    status: requireString(raw, 'status', where),
    components: requireArray(raw, 'components', where).map((component, index) => {
      const componentWhere = `${where}.components[${index}]`;
      if (!isRecord(component)) throw new Error(`Railway status feed: ${componentWhere} is not an object`);
      return {
        name: requireString(component, 'name', componentWhere),
        // Region-less components (Payments & Billing) carry no group.
        groupName: typeof component.groupName === 'string' ? component.groupName : '',
        impact: requireString(component, 'impact', componentWhere),
      };
    }),
    updates: requireArray(raw, 'updates', where).map((update, index) => {
      const updateWhere = `${where}.updates[${index}]`;
      if (!isRecord(update)) throw new Error(`Railway status feed: ${updateWhere} is not an object`);
      return {
        id: requireString(update, 'id', updateWhere),
        status: requireString(update, 'status', updateWhere),
        createdAt: requireTimestamp(update, 'createdAt', updateWhere),
        message: requireString(update, 'message', updateWhere),
      };
    }),
  };
}

/**
 * Railway's status page is their own build, not a vendor with a documented
 * schema. A shape change must turn the run red rather than read as "no
 * incidents" forever, so every field this script uses is checked.
 */
export function parseStatusFeed(raw: unknown): StatusFeed {
  if (!isRecord(raw)) throw new Error('Railway status feed: body is not an object');
  return {
    activeIncidents: requireArray(raw, 'activeIncidents', 'feed').map((incident, index) =>
      parseIncident(incident, `activeIncidents[${index}]`),
    ),
    recentIncidents: requireArray(raw, 'recentIncidents', 'feed').map((incident, index) =>
      parseIncident(incident, `recentIncidents[${index}]`),
    ),
  };
}

/** Lower-case, any dash to `-`, single spaces: "Networking — Public" -> "networking - public". */
export function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      // Figure dash, en dash, em dash, horizontal bar and the Unicode hyphens.
      .replace(/\u2010|\u2011|\u2012|\u2013|\u2014|\u2015/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function componentTier(component: StatusComponent): Tier | null {
  // Railway lists every component an incident might touch and marks the
  // unaffected ones OPERATIONAL ("Potential intermittent connectivity issues").
  if (component.impact === 'OPERATIONAL') return null;
  const name = normalizeName(component.name);
  if (DEPLOY_GLOBAL_COMPONENTS.has(name)) return 'deploys';
  if (!component.groupName.startsWith(OUR_REGION_PREFIX)) return null;
  if (USER_FACING_REGION_COMPONENTS.has(name)) return 'users';
  if (DEPLOY_REGION_COMPONENTS.has(name)) return 'deploys';
  return null;
}

/** The components of this incident that touch us, and the worse of their tiers. */
export function classifyIncident(incident: StatusIncident): { tier: Tier; components: StatusComponent[] } | null {
  const matched = incident.components.flatMap((component) => {
    const tier = componentTier(component);
    return tier ? [{ component, tier }] : [];
  });
  if (matched.length === 0) return null;
  return {
    tier: matched.some(({ tier }) => tier === 'users') ? 'users' : 'deploys',
    components: matched.map(({ component }) => component),
  };
}

function byCreatedAt(first: { update: StatusUpdate }, second: { update: StatusUpdate }): number {
  return Date.parse(first.update.createdAt) - Date.parse(second.update.createdAt);
}

/**
 * What to post, oldest first, and the seen list to store once each post lands.
 *
 * `seen === null` is a lost or never-written state file. Posting every update in
 * a three-month feed would bury the channel, so that run posts only the latest
 * update of each incident still open and records everything else as seen.
 */
export function selectPendingPosts(
  feed: StatusFeed,
  seen: readonly string[] | null,
  nowMs: number,
): { posts: PendingPost[]; alreadySeen: string[] } {
  const relevant = [...feed.activeIncidents, ...feed.recentIncidents].flatMap((incident) => {
    const classification = classifyIncident(incident);
    return classification ? [{ incident, ...classification }] : [];
  });
  // An incident moving from active to recent could be listed in both for one poll.
  const listedIds = new Set<string>();
  const everyUpdate = relevant
    .flatMap(({ incident, tier, components }) =>
      incident.updates.map((update) => ({ incident, update, tier, components })),
    )
    .filter((entry) => {
      if (listedIds.has(entry.update.id)) return false;
      listedIds.add(entry.update.id);
      return true;
    });

  if (seen === null) {
    const activeIds = new Set(feed.activeIncidents.map((incident) => incident.id));
    const posts = relevant
      .filter(({ incident }) => activeIds.has(incident.id) && incident.updates.length > 0)
      .map(({ incident, tier, components }) => {
        const [latest] = incident.updates
          .map((update) => ({ update }))
          .sort(byCreatedAt)
          .slice(-1);
        return { incident, update: latest.update, tier, components };
      })
      .sort(byCreatedAt);
    const postIds = new Set(posts.map((post) => post.update.id));
    return {
      posts,
      alreadySeen: everyUpdate.map((entry) => entry.update.id).filter((updateId) => !postIds.has(updateId)),
    };
  }

  const seenIds = new Set(seen);
  const unseen = everyUpdate.filter((entry) => !seenIds.has(entry.update.id));
  const isFresh = (entry: PendingPost) => nowMs - Date.parse(entry.update.createdAt) <= MAX_UPDATE_AGE_MS;
  return {
    posts: unseen.filter(isFresh).sort(byCreatedAt),
    alreadySeen: [...seen, ...unseen.filter((entry) => !isFresh(entry)).map((entry) => entry.update.id)],
  };
}

/** Newest IDs win when the list outgrows the cap; duplicates collapse. */
export function pruneSeen(seen: readonly string[]): string[] {
  return [...new Set(seen)].slice(-SEEN_LIMIT);
}

function humanize(enumValue: string): string {
  return enumValue.toLowerCase().replace(/_/g, ' ');
}

function sentenceCase(enumValue: string): string {
  const lower = humanize(enumValue);
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "US West (California, USA)" -> "US West". */
function shortGroup(groupName: string): string {
  return groupName.split(' (')[0];
}

function excerpt(message: string): string {
  // One line, no code spans, and no leading `>` to nest a second blockquote.
  const flat = message
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .replace(/^[>\s]+/, '')
    .trim();
  return flat.length <= UPDATE_EXCERPT_LIMIT ? flat : `${flat.slice(0, UPDATE_EXCERPT_LIMIT - 1)}…`;
}

function headline(post: PendingPost): string {
  if (post.update.status === 'RESOLVED') return '✅ Railway resolved an incident';
  return post.tier === 'users'
    ? '🚨 Railway incident likely affecting Boardsesh'
    : '🟡 Railway incident may stall deploys';
}

export function formatDiscordContent(post: PendingPost, health: HealthProbe | null): string {
  const componentLine = post.components
    .map((component) => {
      const group = shortGroup(component.groupName);
      return `${component.name}${group ? ` (${group})` : ''}: ${humanize(component.impact)}`;
    })
    .join(' · ');
  const lines = [
    headline(post),
    `**${post.incident.title.replace(/\*/g, '')}** — ${sentenceCase(post.update.status)}`,
    componentLine,
    `> ${excerpt(post.update.message)}`,
    health ? `Boardsesh database health right now: ${health.detail}` : '',
    // In <…> so Discord does not unfurl a preview under every update.
    `<${INCIDENT_PAGE_BASE}/${post.incident.slug}>`,
  ].filter((line) => line !== '');
  const content = lines.join('\n');
  return content.length <= DISCORD_MESSAGE_LIMIT ? content : `${content.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`;
}

export function readSeen(stateFile: string): string[] | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.seenUpdateIds)) return null;
    return parsed.seenUpdateIds.filter((updateId): updateId is string => typeof updateId === 'string');
  } catch {
    // A truncated cache entry is the same as no cache entry.
    return null;
  }
}

function writeSeen(stateFile: string, seen: readonly string[]): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ seenUpdateIds: seen }, null, 2)}\n`);
}

export async function fetchStatusFeed(fetcher: Fetcher): Promise<StatusFeed> {
  const response = await fetcher(STATUS_API_URL, {
    headers: { accept: 'application/json', 'user-agent': 'boardsesh-railway-status-notify' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Railway status feed answered HTTP ${response.status}`);
  return parseStatusFeed(await response.json());
}

/** Never throws: an unreachable backend is the answer, not an error. */
export async function probeHealth(fetcher: Fetcher): Promise<HealthProbe> {
  try {
    const response = await fetcher(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return { ok: response.ok, detail: `${response.ok ? 'ok' : 'failing'} (${response.status})` };
  } catch {
    return { ok: false, detail: `unreachable (no answer in ${HEALTH_TIMEOUT_MS / 1000} s)` };
  }
}

async function postToDiscord(fetcher: Fetcher, webhookUrl: string, content: string): Promise<void> {
  const response = await fetcher(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Railway writes the update text; parse=[] keeps an @everyone in it inert.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status}`);
}

export type RunOptions = {
  stateFile: string;
  dryRun: boolean;
  webhookUrl: string | undefined;
  fetcher: Fetcher;
  logger: Logger;
  nowMs?: number;
};

export type RunResult = { posted: number; failed: number; changed: boolean };

export async function run(options: RunOptions): Promise<RunResult> {
  const { stateFile, dryRun, webhookUrl, fetcher, logger } = options;
  const feed = await fetchStatusFeed(fetcher);
  const previouslySeen = readSeen(stateFile);
  const { posts, alreadySeen } = selectPendingPosts(feed, previouslySeen, options.nowMs ?? Date.now());
  if (previouslySeen === null) logger.log('No stored state: posting only the latest update of open incidents.');

  const seen = [...alreadySeen];
  const health = posts.some((post) => post.tier === 'users') ? await probeHealth(fetcher) : null;
  let posted = 0;
  let failed = 0;

  for (const post of posts.slice(0, MAX_POSTS_PER_RUN)) {
    const content = formatDiscordContent(post, post.tier === 'users' ? health : null);
    if (dryRun) {
      logger.log(`--- would post (dry run)\n${content}`);
      continue;
    }
    if (!webhookUrl) {
      // Counted as a failure: left green, the update would age past 24 hours
      // and be recorded as seen without anyone having read it.
      failed += 1;
      logger.log(`--- not posted (no webhook)\n${content}`);
      continue;
    }
    try {
      await postToDiscord(fetcher, webhookUrl, content);
      // Seen only once Discord has it, so a failed post is retried next run.
      seen.push(post.update.id);
      posted += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        `Discord post failed for update ${post.update.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (posts.length > MAX_POSTS_PER_RUN) {
    logger.warn(`${posts.length - MAX_POSTS_PER_RUN} update(s) held for the next run.`);
  }
  if (!dryRun && !webhookUrl && posts.length > 0) {
    logger.error('DISCORD_DEPLOY_WEBHOOK is not set: nothing was posted and the update(s) stay unseen.');
  }

  const nextSeen = pruneSeen(seen);
  const changed = !dryRun && JSON.stringify(nextSeen) !== JSON.stringify(previouslySeen);
  if (changed) writeSeen(stateFile, nextSeen);
  logger.log(`${posts.length} new update(s), ${posted} posted, ${failed} failed.`);
  return { posted, failed, changed };
}

export function parseArgs(argv: readonly string[]): { stateFile: string; dryRun: boolean } {
  let stateFile = '.boardsesh/railway-status-seen.json';
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--state-file') {
      const path = argv[index + 1];
      if (!path) throw new Error('--state-file needs a path');
      stateFile = path;
      index += 1;
    } else if (argument !== '--') throw new Error(`Unknown argument: ${argument}`);
  }
  return { stateFile, dryRun };
}

async function main(): Promise<void> {
  const { stateFile, dryRun } = parseArgs(process.argv.slice(2));
  const result = await run({
    stateFile,
    dryRun,
    webhookUrl: process.env.DISCORD_DEPLOY_WEBHOOK || undefined,
    fetcher: fetch,
    logger: console,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  // The red run is the durable record of a post that never reached Discord.
  if (result.failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
