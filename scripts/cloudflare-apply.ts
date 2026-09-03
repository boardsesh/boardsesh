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
 *     The `assets.boardsesh.com` record is fully managed and created when absent:
 *     CNAME → the Tigris bucket target, automatic TTL, DNS-only, with per-record
 *     CNAME flattening disabled. Zone-wide CNAME flattening fails closed because
 *     it would hide the literal answer Tigris verifies.
 *     `www.boardsesh.com` is proxy-only managed like `ws`, so the origin flip
 *     off Vercel is one edit to infra/cloudflare/config.ts (#4655). The apex
 *     `boardsesh.com` is fully managed as a PROXIED, originless A record to the
 *     reserved `192.0.2.0` so Cloudflare terminates it and the redirect rule
 *     below answers — it no longer reaches Vercel at all. Keeping it an A record
 *     makes that an in-place update of the record Vercel already owns rather
 *     than a record-type change.
 *   - Redirect: one rule in the http_request_dynamic_redirect phase sending the
 *     apex to www with a 301, preserving path and query.
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
import { ZONE_NAME, desiredCloudflareState, desiredR2Buckets } from '../infra/cloudflare/config';
import type {
  DnsRecordDesired,
  FullyManagedDnsRecordDesired,
  R2BucketDesired,
  SslMode,
} from '../infra/cloudflare/config';
import {
  MANAGED_RULE_PHASES,
  buildPlan,
  diffR2Bucket,
  resolveRulePhase,
  upsertCacheRule,
} from '../infra/cloudflare/plan';
import type { LiveDnsRecord, LiveR2Bucket, LiveState, PlannedChange, RulesetRule } from '../infra/cloudflare/plan';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// The exact Cloudflare API token scopes this tool needs, printed when the token is
// missing so a maintainer can create one with the right (minimal) permissions.
const TOKEN_SCOPES = [
  'Zone.Zone Read             — resolve the zone id by name + read zone list',
  'Zone.DNS Edit              — manage DNS records + read zone CNAME-flattening settings',
  'Zone.Cache Rules Edit      — create/update the /og/ cache rule',
  'Zone.WAF Edit              — create/update the two crawler rules',
  'Zone.Rate Limit Edit       — create/update the climb-view rate-limit rule (http_ratelimit phase)',
  'Zone.Dynamic Redirect Edit — create/update the apex → www redirect (http_request_dynamic_redirect phase)',
  'Zone.Zone Settings Read    — read the SSL/TLS mode',
  'Zone.Zone Settings Edit    — ONLY needed with --allow-zone-ssl (to set the zone SSL mode)',
  'Account.Workers R2 Storage Write — create R2 buckets + attach their custom domains',
];

// Scopes another consumer of the SAME Production-environment CLOUDFLARE_API_TOKEN
// needs. Printed alongside the list above because a token built from that list
// ALONE authenticates here and fails with `Authentication error [code: 10000]`
// there — which reads as a bad credential, not a missing scope, since
// `wrangler whoami` still succeeds. That regression took app.boardsesh.com off
// the deploy train on 2026-08-25. See the token section of docs/cloudflare.md.
const SHARED_TOKEN_SCOPES = ['Account.Cloudflare Pages Edit — wrangler pages deploy (deploy-app-web)'];

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
    // Reject typos loudly — a silently ignored --appply would dry-run when the
    // operator believed they applied.
    else throw new Error(`Unknown flag: ${argument} (see --help)`);
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
export class CloudflareApiRequestError extends Error {
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
  const zone = zones.find((candidate) => candidate.name === zoneName);
  if (!zone) {
    throw new Error(`Zone "${zoneName}" not found among ${zones.length} zone(s) visible to this token`);
  }
  if (!zone) {
    throw new Error(
      `No Cloudflare zone found for "${zoneName}". Set CLOUDFLARE_ZONE_ID, or grant the token Zone.Zone Read.`,
    );
  }
  return zone.id;
}

/**
 * The record types this tool ever owns.
 *
 * The lookup below is by NAME, and Cloudflare's list endpoint returns every type
 * at that name. `www` and the zone apex routinely carry MX, TXT (SPF, DMARC,
 * domain-verification) and CAA records alongside their address record, and
 * counting those as "the record" would make an ordinary hostname look ambiguous
 * and fail the entire apply. Narrowing to the address types keeps the ambiguity
 * check meaningful: two ADDRESS records at one name is a genuine conflict this
 * tool must not guess its way through.
 */
export const MANAGED_DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME'] as const;

/** Pick the one address record at `name`, or null. Throws when the name carries more than one. */
export function selectManagedDnsRecord(records: LiveDnsRecord[], name: string): LiveDnsRecord | null {
  const addressRecords = records.filter(
    (candidate) => candidate.name === name && (MANAGED_DNS_RECORD_TYPES as readonly string[]).includes(candidate.type),
  );
  if (addressRecords.length > 1) {
    throw new Error(
      `DNS name "${name}" is ambiguous: Cloudflare returned ${addressRecords.length} address records ` +
        `(${addressRecords.map((record) => record.type).join(', ')}). Resolve it in the Cloudflare dashboard first.`,
    );
  }
  return addressRecords[0] ?? null;
}

/** One entry from `GET /accounts/:id/r2/buckets`. */
interface R2BucketListing {
  buckets?: { name: string }[];
}

interface R2CustomDomainListing {
  domains?: { domain: string; enabled?: boolean }[];
}

/**
 * Read the account's R2 buckets and the custom domain attached to each declared one.
 *
 * Only the declared buckets are inspected: this tool has no opinion about
 * buckets it does not own, and listing domains for all of them would be noise.
 */
/**
 * True for "this token is not allowed to do that", as opposed to a real fault.
 *
 * Exported so the decision is testable without standing up the API: the whole
 * point of it is that a missing scope must not be treated like an outage.
 */
export function isAuthorizationError(error: unknown): boolean {
  return error instanceof CloudflareApiRequestError && (error.status === 401 || error.status === 403);
}

/**
 * Read the account's R2 buckets, or null when this token cannot.
 *
 * Returning null rather than throwing on an authorization failure is
 * deliberate. `cf:apply --apply` runs on every production deploy and owns DNS,
 * WAF, rate-limit and redirect rules for the whole zone; R2 drift detection is
 * a nice-to-have beside that. A token that has not (yet) been granted
 * `Account.Workers R2 Storage` must therefore degrade to "skip R2 and say so",
 * not take www off the deploy train — which is exactly how a token rotation
 * that dropped the Pages scope broke app.boardsesh.com on 2026-08-25.
 *
 * It also means the account-id secret and the token scope can be added in
 * either order without a window where deploys fail.
 */
async function fetchR2State(
  token: string,
  accountId: string,
  desired: readonly R2BucketDesired[],
): Promise<Map<string, LiveR2Bucket> | null> {
  let listing: R2BucketListing;
  try {
    listing = await cfRequest<R2BucketListing>(token, 'GET', `/accounts/${accountId}/r2/buckets`);
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;
    console.warn(
      '[cf-apply] Token lacks Account.Workers R2 Storage — skipping R2 buckets. Zone config was still applied. ' +
        'Grant that scope (keeping every existing one: editing a token REPLACES all its policies) to manage R2 here.',
    );
    return null;
  }
  const existing = new Set((listing.buckets ?? []).map((bucket) => bucket.name));

  const state = new Map<string, LiveR2Bucket>();
  for (const bucket of desired) {
    if (!existing.has(bucket.name)) {
      state.set(bucket.name, { name: bucket.name, exists: false, customDomains: [] });
      continue;
    }
    const domains = await cfRequest<R2CustomDomainListing>(
      token,
      'GET',
      `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket.name)}/domains/custom`,
    );
    state.set(bucket.name, {
      name: bucket.name,
      exists: true,
      customDomains: (domains.domains ?? []).map((entry) => entry.domain),
    });
  }
  return state;
}

async function applyR2Bucket(
  token: string,
  accountId: string,
  zoneId: string,
  desired: R2BucketDesired,
  live: LiveR2Bucket | null,
): Promise<void> {
  if (!live || !live.exists) {
    await cfRequest(token, 'POST', `/accounts/${accountId}/r2/buckets`, {
      name: desired.name,
      ...(desired.locationHint && { locationHint: desired.locationHint }),
    });
    console.log(`[cf-apply] created R2 bucket ${desired.name}`);
    // The domain needs the bucket to exist first; the next run attaches it.
    return;
  }

  if (desired.customDomain && !live.customDomains.includes(desired.customDomain)) {
    await cfRequest(
      token,
      'POST',
      `/accounts/${accountId}/r2/buckets/${encodeURIComponent(desired.name)}/domains/custom`,
      { domain: desired.customDomain, zoneId, enabled: true },
    );
    console.log(`[cf-apply] attached ${desired.customDomain} to R2 bucket ${desired.name}`);
  }
}

async function fetchDnsRecord(token: string, zoneId: string, name: string): Promise<LiveDnsRecord | null> {
  const records = await cfRequest<LiveDnsRecord[]>(
    token,
    'GET',
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  );
  return selectManagedDnsRecord(records, name);
}

/** A phase's entrypoint ruleset. Returns an empty rule set when the phase has no ruleset yet (404). */
async function fetchPhaseRules(token: string, zoneId: string, phase: string): Promise<RulesetRule[]> {
  try {
    const ruleset = await cfRequest<{ id: string; rules?: RulesetRule[] }>(
      token,
      'GET',
      `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
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

async function fetchFlattenAllCnames(token: string, zoneId: string): Promise<boolean> {
  const settings = await cfRequest<{ flatten_all_cnames: boolean }>(token, 'GET', `/zones/${zoneId}/dns_settings`);
  if (typeof settings.flatten_all_cnames !== 'boolean') {
    throw new Error(
      `Cloudflare API returned an invalid flatten_all_cnames value for zone ${zoneId}; refusing to apply DNS changes`,
    );
  }
  return settings.flatten_all_cnames;
}

async function fetchLiveState(
  token: string,
  zoneId: string,
  desiredDnsRecords: DnsRecordDesired[],
): Promise<LiveState> {
  const [fetchedDnsRecords, phaseRules, sslMode, flattenAllCnames] = await Promise.all([
    Promise.all(
      desiredDnsRecords.map(
        async (desiredRecord) => [desiredRecord, await fetchDnsRecord(token, zoneId, desiredRecord.name)] as const,
      ),
    ),
    // One read per registered phase: adding a phase to the registry cannot leave
    // the diff comparing against an empty array it never fetched.
    Promise.all(
      MANAGED_RULE_PHASES.map(
        async (phase) => [phase.resource, await fetchPhaseRules(token, zoneId, phase.phase)] as const,
      ),
    ),
    fetchSslMode(token, zoneId),
    fetchFlattenAllCnames(token, zoneId),
  ]);
  // Built straight from the registry: no second place that has to learn about a
  // new phase. The cast is sound because ALL_PHASES_REGISTERED in plan.ts fails
  // the build if a resource has no registry entry, so every key is present.
  const rules = Object.fromEntries(phaseRules) as LiveState['rules'];
  const dnsRecords: Record<string, LiveDnsRecord | null> = {};
  for (const [desiredRecord, liveRecord] of fetchedDnsRecords) {
    if (!liveRecord && desiredRecord.management === 'proxied-only') {
      throw new Error(
        `DNS record "${desiredRecord.name}" not found in zone ${zoneId}. This tool manages only its proxied flag; ` +
          `create the record first in the system that owns its target.`,
      );
    }
    dnsRecords[desiredRecord.name] = liveRecord;
  }
  return { dnsRecords, rules, sslMode, flattenAllCnames };
}

export function fullyManagedDnsBody(desired: FullyManagedDnsRecordDesired): Record<string, unknown> {
  return {
    type: desired.type,
    name: desired.name,
    content: desired.content,
    ttl: desired.ttl,
    proxied: desired.proxied,
    // Left out entirely when we do not own it. `settings: undefined` would
    // serialise away anyway, but an explicit omission is what documents that a
    // proxied record has no per-record flattening for us to set.
    ...(desired.settings ? { settings: desired.settings } : {}),
  };
}

async function applyDnsRecord(
  token: string,
  zoneId: string,
  desired: DnsRecordDesired,
  liveRecord: LiveDnsRecord | null,
): Promise<void> {
  if (!liveRecord) {
    if (desired.management === 'proxied-only') {
      throw new Error(`Cannot create proxy-only DNS record "${desired.name}"; its target is intentionally unmanaged`);
    }
    await cfRequest(token, 'POST', `/zones/${zoneId}/dns_records`, fullyManagedDnsBody(desired));
    return;
  }

  const body = desired.management === 'proxied-only' ? { proxied: desired.proxied } : fullyManagedDnsBody(desired);
  await cfRequest(token, 'PATCH', `/zones/${zoneId}/dns_records/${liveRecord.id}`, body);
}

async function applyPhaseRules(token: string, zoneId: string, phase: string, rules: RulesetRule[]): Promise<void> {
  // PUT to the phase entrypoint creates the ruleset when it doesn't exist yet, or
  // replaces its rules array when it does. It REPLACES — so `rules` must always be
  // the merged array from upsertCacheRule, which carries every foreign rule through
  // verbatim. Sending only our own rules here would delete the zone's other rules,
  // including the WAF rule that blocks the AI crawlers.
  await cfRequest(token, 'PUT', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { rules });
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
  console.error('           The same token is shared with other jobs. Keep their scopes on it too:');
  for (const scope of SHARED_TOKEN_SCOPES) console.error(`             ${scope}`);
  console.error('           https://dash.cloudflare.com/profile/api-tokens');
}

/**
 * The whole run: read, plan, print, and (with --apply) converge. Exported and
 * argv-injected so a test can drive it end to end against a stubbed `fetch` and
 * assert which requests it actually makes — the apply loop routes every rule
 * phase through one branch, and "the loop quietly skipped a phase" is a bug no
 * amount of pure-function testing can see.
 */
export async function runCloudflareApply(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

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
  const live = await fetchLiveState(token, zoneId, desired.dnsRecords);
  const changes = buildPlan(desired, live, { allowZoneSsl: options.allowZoneSsl });

  // R2 is ACCOUNT-scoped, unlike everything else here. It is skipped rather
  // than fatal when the account id is absent, so the existing zone-only CI job
  // (which passes no account id and holds no R2 scope) keeps working untouched.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  let r2State: Map<string, LiveR2Bucket> | null = null;
  if (accountId) {
    r2State = await fetchR2State(token, accountId, desiredR2Buckets);
    if (r2State) {
      for (const bucket of desiredR2Buckets) {
        changes.push(...diffR2Bucket(bucket, r2State.get(bucket.name) ?? null));
      }
    }
  } else {
    console.log('[cf-apply] CLOUDFLARE_ACCOUNT_ID not set — skipping R2 buckets (needs Workers R2 Storage:Write).');
  }

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

  // Mutations are applied sequentially with no rollback: a mid-apply failure
  // leaves the zone partially converged. Safe because the plan is ordered
  // (SSL -> cache rule -> proxied flip last) and re-running converges the rest.
  const appliedPhases = new Set<string>();
  for (const change of changes) {
    if (change.blocked) {
      console.warn(`[cf-apply] SKIPPED (blocked): ${change.summary}`);
      if (change.detail) console.warn(`             ${change.detail.split('\n')[0]}`);
      blockedRemaining += 1;
      continue;
    }

    if (change.resource === 'r2-bucket') {
      const bucket = desiredR2Buckets.find((candidate) => candidate.name === change.r2BucketName);
      if (!bucket || !accountId || !r2State) throw new Error(`Unresolvable R2 change: ${change.summary}`);
      await applyR2Bucket(token, accountId, zoneId, bucket, r2State.get(bucket.name) ?? null);
      continue;
    }

    if (change.resource === 'dns') {
      const desiredRecord = desired.dnsRecords.find((record) => record.name === change.dnsName);
      if (!desiredRecord) throw new Error(`No desired DNS record found for planned change "${change.dnsName}"`);
      await applyDnsRecord(token, zoneId, desiredRecord, live.dnsRecords[desiredRecord.name] ?? null);
      console.log(`[cf-apply] applied: ${change.summary}`);
    } else if (change.resource === 'ssl') {
      await applySslMode(token, zoneId, desired.ssl.mode);
      console.log(`[cf-apply] applied: ${change.summary}`);
    } else {
      // One PUT per phase, not per planned change. The plan reports each drifted
      // rule separately so a dry-run names them, but the rulesets API only offers
      // a whole-phase write and the merged array already contains every rule.
      //
      // Resolved through the registry rather than a ternary: an unregistered
      // resource throws here instead of falling out of the chain and reporting
      // "applied" for a write that never happened.
      const phase = resolveRulePhase(change.resource);
      if (!appliedPhases.has(phase.phase)) {
        const { rules } = upsertCacheRule(phase.selectLive(live), [...phase.selectDesired(desired)]);
        await applyPhaseRules(token, zoneId, phase.phase, rules);
        appliedPhases.add(phase.phase);
      }
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
export { CF_API_BASE, SHARED_TOKEN_SCOPES, TOKEN_SCOPES, ZONE_NAME };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudflareApply()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[cf-apply] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
