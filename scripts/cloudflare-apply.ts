/// <reference types="node" />

/**
 * Config-as-code for the Cloudflare-managed boardsesh.com zone. Reads the declarative
 * desired state (infra/cloudflare/config.ts), fetches the live zone state, diffs them
 * (infra/cloudflare/plan.ts), and reports or converges the delta. Idempotent: a second
 * run with no drift is a no-op.
 *
 * What it manages (and nothing else on the zone):
 *   - DNS: the `ws.boardsesh.com` record's proxied flag → true (orange cloud). The
 *     record's target/type/content are NOT managed — the record already exists.
 *   - Cache: one rule in the http_request_cache_settings phase that makes
 *     ws.boardsesh.com/og/* eligible for cache and respects the origin TTL. Any OTHER
 *     rule already in that phase is preserved verbatim.
 *   - SSL: asserts the zone SSL/TLS mode is `strict` (Full (strict)). If the zone-wide
 *     mode is weaker it is REPORTED, never silently changed — the setting affects every
 *     hostname on the zone. Pass --allow-zone-ssl to opt into setting it.
 *
 * Modes:
 *   (default)          Dry-run. Fetch live state, print the diff, exit non-zero if any
 *                      drift exists (so CI can gate on it). Never mutates.
 *   --apply            Perform only the needed mutations. No-op when live matches desired.
 *   --allow-zone-ssl   Also set the zone-wide SSL mode when it is weaker than strict.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... vp run cf:apply                          # dry-run (default)
 *   CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply               # converge
 *   CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply --allow-zone-ssl
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN  (required) API token — see TOKEN_SCOPES below for the exact scopes.
 *   CLOUDFLARE_ZONE_ID    (optional) Skip the name→id lookup. When unset, the zone id is
 *                         resolved by name "boardsesh.com" via the API (needs Zone.Zone Read).
 *
 * See docs/og-climb.md ("Cloudflare in front of ws.boardsesh.com").
 */

import { pathToFileURL } from 'node:url';
import { CACHE_RULE_PHASE, ZONE_NAME, desiredCloudflareState } from '../infra/cloudflare/config';
import type { SslMode } from '../infra/cloudflare/config';
import { buildPlan, upsertCacheRule } from '../infra/cloudflare/plan';
import type { LiveDnsRecord, LiveState, PlannedChange, RulesetRule } from '../infra/cloudflare/plan';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// The exact Cloudflare API token scopes this tool needs, printed when the token is
// missing so a maintainer can create one with the right (minimal) permissions.
const TOKEN_SCOPES = [
  'Zone.Zone Read           — resolve the zone id by name + read zone list',
  'Zone.DNS Edit            — patch the ws.boardsesh.com record proxied flag',
  'Zone.Cache Rules Edit    — create/update the /og/ cache rule',
  'Zone.Zone Settings Read  — read the SSL/TLS mode',
  'Zone.Zone Settings Edit  — ONLY needed with --allow-zone-ssl (to set the zone SSL mode)',
];

export interface CliOptions {
  apply: boolean;
  allowZoneSsl: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let allowZoneSsl = false;
  let help = false;

  for (const argument of argv) {
    if (argument === '--') continue;
    else if (argument === '--apply') apply = true;
    else if (argument === '--dry-run') apply = false;
    else if (argument === '--allow-zone-ssl') allowZoneSsl = true;
    else if (argument === '--help' || argument === '-h') help = true;
  }

  return { apply, allowZoneSsl, help };
}

interface CloudflareApiError {
  code: number;
  message: string;
}

interface CloudflareEnvelope<TResult> {
  success: boolean;
  errors: CloudflareApiError[];
  messages: unknown[];
  result: TResult;
}

/** Error carrying the HTTP status + surfaced Cloudflare error messages, so callers can branch on status. */
class CloudflareApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cfErrors: CloudflareApiError[],
  ) {
    super(message);
    this.name = 'CloudflareApiRequestError';
  }
}

async function cfRequest<TResult>(token: string, method: string, path: string, body?: unknown): Promise<TResult> {
  const response = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const rawBody = await response.text();
  let envelope: CloudflareEnvelope<TResult> | null = null;
  try {
    envelope = rawBody ? (JSON.parse(rawBody) as CloudflareEnvelope<TResult>) : null;
  } catch {
    // Non-JSON body (e.g. an HTML error page) — handled below via the raw text.
  }

  if (!response.ok || !envelope || envelope.success === false) {
    const cfErrors = envelope?.errors ?? [];
    const rendered = cfErrors.map((error) => `  - [${error.code}] ${error.message}`).join('\n');
    throw new CloudflareApiRequestError(
      `Cloudflare API ${method} ${path} failed (HTTP ${response.status}).` +
        (rendered ? `\n${rendered}` : `\n  ${rawBody.slice(0, 500)}`),
      response.status,
      cfErrors,
    );
  }

  return envelope.result;
}

async function resolveZoneId(token: string, zoneName: string): Promise<string> {
  const fromEnv = process.env.CLOUDFLARE_ZONE_ID?.trim();
  if (fromEnv) return fromEnv;

  const zones = await cfRequest<Array<{ id: string; name: string }>>(
    token,
    'GET',
    `/zones?name=${encodeURIComponent(zoneName)}`,
  );
  const zone = zones.find((candidate) => candidate.name === zoneName) ?? zones[0];
  if (!zone) {
    throw new Error(
      `No Cloudflare zone found for "${zoneName}". Set CLOUDFLARE_ZONE_ID, or grant the token Zone.Zone Read.`,
    );
  }
  return zone.id;
}

async function fetchDnsRecord(token: string, zoneId: string, name: string): Promise<LiveDnsRecord> {
  const records = await cfRequest<LiveDnsRecord[]>(
    token,
    'GET',
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  );
  const record = records.find((candidate) => candidate.name === name);
  if (!record) {
    throw new Error(
      `DNS record "${name}" not found in zone ${zoneId}. This tool only patches the existing ` +
        `record's proxied flag — create the record first (in the dashboard or your DNS pipeline).`,
    );
  }
  return record;
}

/** The cache-phase entrypoint ruleset. Returns an empty rule set when the phase has no ruleset yet (404). */
async function fetchCacheRules(token: string, zoneId: string): Promise<RulesetRule[]> {
  try {
    const ruleset = await cfRequest<{ id: string; rules?: RulesetRule[] }>(
      token,
      'GET',
      `/zones/${zoneId}/rulesets/phases/${CACHE_RULE_PHASE}/entrypoint`,
    );
    return ruleset.rules ?? [];
  } catch (error) {
    // A phase with no ruleset 404s on the entrypoint — that's an empty rule set, not a failure.
    if (error instanceof CloudflareApiRequestError && error.status === 404) return [];
    throw error;
  }
}

async function fetchSslMode(token: string, zoneId: string): Promise<string> {
  const setting = await cfRequest<{ id: string; value: string }>(token, 'GET', `/zones/${zoneId}/settings/ssl`);
  return setting.value;
}

async function fetchLiveState(token: string, zoneId: string, dnsName: string): Promise<LiveState> {
  const [dnsRecord, cacheRules, sslMode] = await Promise.all([
    fetchDnsRecord(token, zoneId, dnsName),
    fetchCacheRules(token, zoneId),
    fetchSslMode(token, zoneId),
  ]);
  return { dnsRecord, cacheRules, sslMode };
}

async function applyDnsProxied(token: string, zoneId: string, recordId: string, proxied: boolean): Promise<void> {
  await cfRequest(token, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { proxied });
}

async function applyCacheRules(token: string, zoneId: string, rules: RulesetRule[]): Promise<void> {
  // PUT to the phase entrypoint creates the ruleset when it doesn't exist yet, or
  // replaces its rules array when it does. We send the merged array (foreign rules
  // preserved), so this only ever adds/updates our rule.
  await cfRequest(token, 'PUT', `/zones/${zoneId}/rulesets/phases/${CACHE_RULE_PHASE}/entrypoint`, { rules });
}

async function applySslMode(token: string, zoneId: string, mode: SslMode): Promise<void> {
  await cfRequest(token, 'PATCH', `/zones/${zoneId}/settings/ssl`, { value: mode });
}

function printPlan(changes: PlannedChange[]): void {
  for (const change of changes) {
    const marker = change.blocked ? '[blocked]' : '[change] ';
    console.log(`  ${marker} (${change.resource}) ${change.summary}`);
    if (change.detail) {
      for (const line of change.detail.split('\n')) console.log(`             ${line}`);
    }
  }
}

function printTokenScopes(): void {
  console.error('[cf-apply] CLOUDFLARE_API_TOKEN is required. Create a token with these scopes on the zone:');
  for (const scope of TOKEN_SCOPES) console.error(`             ${scope}`);
  console.error('           https://dash.cloudflare.com/profile/api-tokens');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(
      [
        'Usage: vp run cf:apply -- [--apply] [--allow-zone-ssl]',
        '',
        '  (default)         Dry-run: print the diff, exit non-zero if drift exists. Never mutates.',
        '  --apply           Converge the zone to the desired state (only the needed mutations).',
        '  --allow-zone-ssl  Also set the zone-wide SSL/TLS mode when it is weaker than strict.',
        '',
        'Env: CLOUDFLARE_API_TOKEN (required), CLOUDFLARE_ZONE_ID (optional).',
      ].join('\n'),
    );
    return 0;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    printTokenScopes();
    return 1;
  }

  const desired = desiredCloudflareState;

  console.log(`[cf-apply] Zone: ${desired.zoneName}`);
  console.log(`[cf-apply] Mode: ${options.apply ? 'APPLY' : 'dry-run (pass --apply to converge)'}`);
  console.log('');

  const zoneId = await resolveZoneId(token, desired.zoneName);
  const live = await fetchLiveState(token, zoneId, desired.dns.name);
  const changes = buildPlan(desired, live, { allowZoneSsl: options.allowZoneSsl });

  if (changes.length === 0) {
    console.log('[cf-apply] In sync — nothing to do.');
    return 0;
  }

  console.log(`[cf-apply] Planned changes (${changes.length}):`);
  printPlan(changes);
  console.log('');

  if (!options.apply) {
    console.log('[cf-apply] Dry-run: no changes applied. Re-run with --apply to converge.');
    // Non-zero exit signals drift so CI can gate on it.
    return 1;
  }

  let blockedRemaining = 0;

  for (const change of changes) {
    if (change.blocked) {
      console.warn(`[cf-apply] SKIPPED (blocked): ${change.summary}`);
      if (change.detail) console.warn(`             ${change.detail.split('\n')[0]}`);
      blockedRemaining += 1;
      continue;
    }

    if (change.resource === 'dns') {
      await applyDnsProxied(token, zoneId, live.dnsRecord.id, desired.dns.proxied);
      console.log(`[cf-apply] applied: ${change.summary}`);
    } else if (change.resource === 'cache-rule') {
      const { rules } = upsertCacheRule(live.cacheRules, desired.cacheRule);
      await applyCacheRules(token, zoneId, rules);
      console.log(`[cf-apply] applied: ${change.summary}`);
    } else if (change.resource === 'ssl') {
      await applySslMode(token, zoneId, desired.ssl.mode);
      console.log(`[cf-apply] applied: ${change.summary}`);
    }
  }

  console.log('');
  if (blockedRemaining > 0) {
    console.log(
      `[cf-apply] Done, but ${blockedRemaining} change(s) were blocked and left unapplied ` +
        `(re-run with --allow-zone-ssl to include the zone-wide SSL change).`,
    );
    return 1;
  }

  console.log('[cf-apply] Done — zone converged to desired state.');
  return 0;
}

// Exported for docs/tests: the module can be imported without running the CLI.
export { CF_API_BASE, TOKEN_SCOPES, ZONE_NAME };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[cf-apply] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
