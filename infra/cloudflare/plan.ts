/// <reference types="node" />

// Pure planning logic for the Cloudflare apply tool: diff desired-vs-live and merge
// our cache rule into an existing rules array without disturbing foreign rules. No
// I/O, no globals — everything here is deterministic and unit-tested in
// scripts/cloudflare-apply.test.ts. The I/O (fetching live state, applying changes)
// lives in scripts/cloudflare-apply.ts.

import { CACHE_RULE_PHASE, RATE_LIMIT_RULE_PHASE, SSL_MODE_STRENGTH, WAF_RULE_PHASE, ZONE_NAME } from './config';
import type {
  CacheRuleDesired,
  DnsRecordDesired,
  RateLimitRuleDesired,
  SslDesired,
  SslMode,
  WafRuleDesired,
} from './config';

/** Anything this tool owns inside a ruleset phase. Identity is the description marker. */
export type ManagedRuleDesired = CacheRuleDesired | WafRuleDesired | RateLimitRuleDesired;

/** A DNS record as Cloudflare returns it. Which fields are owned depends on the desired record's management mode. */
export interface LiveDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  settings?: {
    flatten_cname?: boolean;
  };
}

/**
 * A rule inside a ruleset phase, as Cloudflare returns it. Cloudflare adds read-only
 * fields (version, last_updated, ref) we neither set nor rely on; foreign rules are
 * preserved verbatim at runtime by object spread even when a field isn't named here.
 */
export interface RulesetRule {
  id?: string;
  description?: string;
  expression?: string;
  action?: string;
  // Widened to `unknown`: foreign rules carry arbitrary action parameters we never
  // read, and it keeps our strongly-typed desired rule assignable here. Compared
  // structurally via jsonEqual, never accessed by shape.
  action_parameters?: unknown;
  // Rate-limit rules carry their counter config here rather than in
  // action_parameters. Same treatment: compared structurally, never by shape.
  ratelimit?: unknown;
  enabled?: boolean;
  version?: string;
  last_updated?: string;
  ref?: string;
}

/** Live zone state the plan diffs against, gathered by the apply script's read phase. */
export interface LiveState {
  /** One entry per desired hostname. Fully managed records may be null when they need creation. */
  dnsRecords: Record<string, LiveDnsRecord | null>;
  cacheRules: RulesetRule[];
  /** Rules live in the WAF custom phase. Empty when the phase has no entrypoint ruleset yet. */
  wafRules: RulesetRule[];
  /** Rate-limit phase. Commonly absent entirely on a zone that never had one; reads as empty. */
  rateLimitRules: RulesetRule[];
  sslMode: string;
  /** Zone-wide flattening overrides per-record settings and breaks Tigris CNAME verification. */
  flattenAllCnames: boolean;
}

/** One planned-change kind per managed ruleset phase. */
export type ManagedRuleResource = 'cache-rule' | 'waf-rule' | 'rate-limit-rule';

/**
 * Every ruleset phase this tool owns, in one place.
 *
 * This exists because the read, the diff and the apply each used to name the
 * phases independently — two `fetchPhaseRules` calls, two `diffManagedRules`
 * calls, and an `if/else if` chain with no `else`. Adding a third phase to two
 * of those three and forgetting the third produced a dry-run that reported
 * drift and an apply that silently wrote nothing. Driving all three from this
 * array means a new phase is one entry, and `resolveRulePhase` throws rather
 * than falling through if anything ever gets out of step.
 */
export interface ManagedRulePhase {
  readonly resource: ManagedRuleResource;
  /** Cloudflare rulesets phase name, used for both the GET and the PUT. */
  readonly phase: string;
  /** How the phase is named in dry-run output. */
  readonly label: string;
  readonly selectLive: (live: LiveState) => RulesetRule[];
  readonly selectDesired: (desired: DesiredRuleSets) => readonly ManagedRuleDesired[];
}

/** The subset of the desired state that the phase registry selects from. */
export interface DesiredRuleSets {
  cacheRules: CacheRuleDesired[];
  wafRules: WafRuleDesired[];
  rateLimitRules: RateLimitRuleDesired[];
}

export const MANAGED_RULE_PHASES: readonly ManagedRulePhase[] = [
  {
    resource: 'cache-rule',
    phase: CACHE_RULE_PHASE,
    label: 'Cache rule',
    selectLive: (live) => live.cacheRules,
    selectDesired: (desired) => desired.cacheRules,
  },
  {
    resource: 'waf-rule',
    phase: WAF_RULE_PHASE,
    label: 'WAF rule',
    selectLive: (live) => live.wafRules,
    selectDesired: (desired) => desired.wafRules,
  },
  {
    resource: 'rate-limit-rule',
    phase: RATE_LIMIT_RULE_PHASE,
    label: 'Rate-limit rule',
    selectLive: (live) => live.rateLimitRules,
    selectDesired: (desired) => desired.rateLimitRules,
  },
];

/**
 * The registry entry for a planned change, or a loud failure.
 *
 * The apply loop routes through this instead of a ternary so that an
 * unregistered resource stops the run rather than skipping the write — the
 * difference between "the deploy failed" and "the deploy said applied and the
 * zone never changed".
 */
export function resolveRulePhase(resource: ManagedRuleResource): ManagedRulePhase {
  const entry = MANAGED_RULE_PHASES.find((candidate) => candidate.resource === resource);
  if (!entry) {
    throw new Error(
      `No managed ruleset phase registered for resource "${resource}". ` +
        `Add it to MANAGED_RULE_PHASES in infra/cloudflare/plan.ts.`,
    );
  }
  return entry;
}

export interface PlanOptions {
  /** Permit the (opt-in) zone-wide SSL mutation. When false, a weaker SSL mode is reported but not applied. */
  allowZoneSsl: boolean;
}

export interface PlannedChange {
  resource: 'dns' | ManagedRuleResource | 'ssl';
  /** One-line human-readable summary of what would change. */
  summary: string;
  /** Optional extra context printed under the summary. */
  detail?: string;
  /** Present for DNS changes so the apply layer can select the right desired/live record. */
  dnsName?: string;
  /**
   * true = a change that is NOT auto-applied: the zone-wide SSL mutation
   * requires an explicit opt-in flag (it affects every host on the zone), and
   * the proxied flip is held back while a required SSL change is blocked.
   */
  blocked?: boolean;
}

/** Deep structural equality for plain JSON values (objects, arrays, primitives). Key order independent. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonEqual(item, right[index]));
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && jsonEqual(leftRecord[key], rightRecord[key]),
    );
  }

  return false;
}

/** True when a live rule already matches the fields we manage (identity is by description, checked by the caller). */
export function cacheRuleMatches(liveRule: RulesetRule, desiredRule: ManagedRuleDesired): boolean {
  return (
    liveRule.expression === desiredRule.expression &&
    liveRule.action === desiredRule.action &&
    (liveRule.enabled ?? true) === desiredRule.enabled &&
    // Both payload fields are per-variant: cache and WAF rules carry
    // action_parameters, rate-limit rules carry ratelimit instead. Compare each
    // only where it exists, and treat absent as undefined so a rule that should
    // have neither cannot match one that has one.
    jsonEqual(
      liveRule.action_parameters,
      'action_parameters' in desiredRule ? desiredRule.action_parameters : undefined,
    ) &&
    // Without this a rate-limit rule is write-once: its threshold, window and
    // characteristics all live under `ratelimit`, so re-tuning the number
    // would diff clean and never reach the zone.
    jsonEqual(liveRule.ratelimit, 'ratelimit' in desiredRule ? desiredRule.ratelimit : undefined)
  );
}

/** Element-wise comparison used to decide whether an upsert actually changed anything. */
function sameRule(liveRule: RulesetRule | undefined, nextRule: RulesetRule): boolean {
  if (liveRule === nextRule) return true;
  if (!liveRule) return false;
  return (
    liveRule.description === nextRule.description &&
    liveRule.expression === nextRule.expression &&
    liveRule.action === nextRule.action &&
    (liveRule.enabled ?? true) === (nextRule.enabled ?? true) &&
    jsonEqual(liveRule.action_parameters, nextRule.action_parameters) &&
    jsonEqual(liveRule.ratelimit, nextRule.ratelimit)
  );
}

export interface CacheRuleUpsertResult {
  /** The rules array to PUT back. Foreign rules keep their order and every field verbatim. */
  rules: RulesetRule[];
  /** Whether our rule was created or updated (false = already in the desired state). */
  changed: boolean;
}

/**
 * Merge our desired rules into an existing phase's rules array. Ours are identified
 * only by their description markers, so:
 *   - none present → append the whole group, in declared order, at the end.
 *   - some present → rewrite them as one contiguous group at the position of the
 *     first one we own, keeping each rule's Cloudflare-assigned id.
 *   - already in the desired state → return the array unchanged (no-op).
 *
 * Every rule we do NOT own is preserved verbatim, by reference, in its original
 * relative order.
 *
 * The contiguous-group rewrite is what makes WAF ordering safe. Upserting rule by
 * rule would append a newly-added allow rule AFTER an already-present block rule,
 * which reverses their precedence and blocks the search engines the allow rule
 * exists to protect. Declared order in the group always wins.
 *
 * What this deliberately does not do is reorder our group relative to foreign
 * rules — a pre-existing foreign block rule that runs before ours keeps running
 * first. Cloudflare's own AI-crawler block is exactly such a rule and must stay
 * ahead of us.
 */
export function upsertCacheRule(
  existingRules: RulesetRule[],
  desiredRules: ManagedRuleDesired | ManagedRuleDesired[],
): CacheRuleUpsertResult {
  const desired = Array.isArray(desiredRules) ? desiredRules : [desiredRules];
  const managedDescriptions = new Set(desired.map((rule) => rule.description));
  const isManaged = (rule: RulesetRule) => rule.description !== undefined && managedDescriptions.has(rule.description);

  const idByDescription = new Map<string, string>();
  for (const rule of existingRules) {
    if (isManaged(rule) && rule.id) idByDescription.set(rule.description as string, rule.id);
  }

  const managedBlock: RulesetRule[] = desired.map((rule) => {
    const existingId = idByDescription.get(rule.description);
    return existingId ? { id: existingId, ...rule } : { ...rule };
  });

  const foreignRules = existingRules.filter((rule) => !isManaged(rule));
  const firstManagedIndex = existingRules.findIndex(isManaged);
  const insertAt =
    firstManagedIndex === -1
      ? foreignRules.length
      : existingRules.slice(0, firstManagedIndex).filter((rule) => !isManaged(rule)).length;

  const rules = [...foreignRules.slice(0, insertAt), ...managedBlock, ...foreignRules.slice(insertAt)];
  const changed =
    rules.length !== existingRules.length || rules.some((rule, index) => !sameRule(existingRules[index], rule));

  return { rules: changed ? rules : existingRules, changed };
}

/** Render Cloudflare's special automatic-TTL value without mislabelling future explicit TTLs. */
function describeDnsTtl(ttl: number): string {
  return ttl === 1 ? 'automatic' : String(ttl);
}

/** Plan creation or owned-field convergence for one DNS record. */
export function diffDnsRecord(desired: DnsRecordDesired, liveRecord: LiveDnsRecord | null): PlannedChange | null {
  if (!liveRecord) {
    if (desired.management === 'proxied-only') {
      throw new Error(
        `DNS record "${desired.name}" is missing. It is proxy-only managed and must be created outside this tool.`,
      );
    }
    return {
      resource: 'dns',
      dnsName: desired.name,
      summary: `DNS ${desired.name}: missing — will create`,
      detail:
        `${desired.type} ${desired.name} → ${desired.content}, ttl ${describeDnsTtl(desired.ttl)}, ` +
        `proxied ${desired.proxied}, ` +
        `CNAME flattening disabled`,
    };
  }

  if (desired.management === 'proxied-only') {
    if (liveRecord.proxied === desired.proxied) return null;
    return {
      resource: 'dns',
      dnsName: desired.name,
      summary: `DNS ${desired.name}: set proxied ${liveRecord.proxied} → ${desired.proxied}`,
      detail: `record ${liveRecord.type} ${liveRecord.name} → ${liveRecord.content} (target unchanged; only the proxied flag is managed)`,
    };
  }

  const driftedFields: string[] = [];
  if (liveRecord.type !== desired.type) driftedFields.push(`type ${liveRecord.type} → ${desired.type}`);
  if (liveRecord.content !== desired.content) driftedFields.push(`content ${liveRecord.content} → ${desired.content}`);
  if (liveRecord.ttl !== desired.ttl) {
    driftedFields.push(`ttl ${describeDnsTtl(liveRecord.ttl)} → ${describeDnsTtl(desired.ttl)}`);
  }
  if (liveRecord.proxied !== desired.proxied) {
    driftedFields.push(`proxied ${liveRecord.proxied} → ${desired.proxied}`);
  }
  if ((liveRecord.settings?.flatten_cname ?? false) !== desired.settings.flatten_cname) {
    driftedFields.push(
      `flatten_cname ${liveRecord.settings?.flatten_cname ?? false} → ${desired.settings.flatten_cname}`,
    );
  }
  if (driftedFields.length === 0) return null;

  return {
    resource: 'dns',
    dnsName: desired.name,
    summary: `DNS ${desired.name}: managed fields differ — will update`,
    detail: driftedFields.join(', '),
  };
}

/**
 * Plan the changes for one ruleset phase — one PlannedChange per rule that is
 * missing or has drifted. Returns an empty array when the phase already matches.
 *
 * Reported per rule rather than per phase so a dry-run says which rule drifted;
 * the apply itself still PUTs the phase once, because that is the only write the
 * rulesets API offers.
 */
export function diffManagedRules(
  existingRules: RulesetRule[],
  desiredRules: readonly ManagedRuleDesired[],
  resource: ManagedRuleResource,
): PlannedChange[] {
  const { changed } = upsertCacheRule(existingRules, [...desiredRules]);
  if (!changed) return [];

  const managedDescriptions = new Set(desiredRules.map((rule) => rule.description));
  const foreignCount = existingRules.filter(
    (rule) => rule.description === undefined || !managedDescriptions.has(rule.description),
  ).length;
  const { label } = resolveRulePhase(resource);

  const changes: PlannedChange[] = [];
  for (const desiredRule of desiredRules) {
    const liveRule = existingRules.find((rule) => rule.description === desiredRule.description);
    if (liveRule && cacheRuleMatches(liveRule, desiredRule)) continue;
    changes.push({
      resource,
      summary: liveRule
        ? `${label} "${desiredRule.description}" differs from desired — will update`
        : `${label} "${desiredRule.description}" missing — will create`,
      detail: `${desiredRule.action}: ${desiredRule.expression}`,
    });
  }

  // Every rule matches individually but the array still changed: our group is in
  // the wrong order. For WAF that is the difference between allowing Googlebot and
  // blocking it, so it must surface as its own planned change rather than silently.
  if (changes.length === 0) {
    changes.push({
      resource,
      summary: `${label}s are present but out of order — will reorder`,
      detail: `desired order: ${desiredRules.map((rule) => rule.description).join(' → ')}`,
    });
  }

  if (foreignCount > 0) {
    changes[changes.length - 1] = {
      ...changes[changes.length - 1],
      detail: `${changes[changes.length - 1].detail}\n    (${foreignCount} other rule(s) in this phase left untouched)`,
    };
  }

  return changes;
}

/** Back-compat single-rule wrapper. Returns the first planned change, or null when in sync. */
export function diffCacheRule(existingRules: RulesetRule[], desiredRule: CacheRuleDesired): PlannedChange | null {
  return diffManagedRules(existingRules, [desiredRule], 'cache-rule')[0] ?? null;
}

/** Index of a mode in the weakest→strongest order, or -1 for an unknown mode. */
function sslModeStrength(mode: string): number {
  return SSL_MODE_STRENGTH.indexOf(mode as SslMode);
}

/**
 * Plan the SSL mode change, or null when the live mode already meets the requirement.
 * We only ever upgrade toward the desired mode — never downgrade — and we never
 * silently mutate a zone-wide setting: when the live mode is weaker and allowZoneSsl
 * is false the change is returned `blocked`, so dry-run reports drift but --apply
 * leaves the zone-wide setting alone.
 */
export function diffSslMode(desiredMode: SslMode, liveMode: string, allowZoneSsl: boolean): PlannedChange | null {
  if (liveMode === desiredMode) return null;

  const liveStrength = sslModeStrength(liveMode);
  const desiredStrength = sslModeStrength(desiredMode);
  // Don't touch a zone that's already at least as strict as we require (or stricter).
  if (liveStrength >= 0 && liveStrength >= desiredStrength) return null;

  return {
    resource: 'ssl',
    blocked: !allowZoneSsl,
    summary: `Zone SSL mode "${liveMode}" is weaker than required "${desiredMode}"`,
    detail: allowZoneSsl
      ? `Will set the zone-wide SSL/TLS mode to "${desiredMode}" (--allow-zone-ssl given).`
      : `Left unchanged: the zone-wide SSL/TLS setting affects every hostname on ${ZONE_NAME}. ` +
        `Re-run with --allow-zone-ssl to set it, or change it in the Cloudflare dashboard.`,
  };
}

/** Full desired-vs-live diff: the ordered list of changes --apply would attempt. Empty = in sync. */
export function buildPlan(
  desired: DesiredRuleSets & {
    dnsRecords: DnsRecordDesired[];
    ssl: SslDesired;
  },
  live: LiveState,
  options: PlanOptions,
): PlannedChange[] {
  const requiresLiteralCname = desired.dnsRecords.some(
    (record) =>
      record.management === 'full' &&
      record.type === 'CNAME' &&
      !record.proxied &&
      record.settings.flatten_cname === false,
  );
  if (requiresLiteralCname && live.flattenAllCnames) {
    throw new Error(
      `Cloudflare zone-wide CNAME flattening is enabled for ${ZONE_NAME}. ` +
        `Disable "Flatten all CNAMEs" before applying: it overrides the per-record setting and hides the literal ` +
        `CNAME required for Tigris custom-domain verification.`,
    );
  }

  const changes: PlannedChange[] = [];

  const dnsChanges = desired.dnsRecords.flatMap((desiredRecord) => {
    const change = diffDnsRecord(desiredRecord, live.dnsRecords[desiredRecord.name] ?? null);
    return change ? [change] : [];
  });

  // Driven by MANAGED_RULE_PHASES so the plan can never cover fewer phases than
  // the apply writes, or vice versa.
  const ruleChanges = MANAGED_RULE_PHASES.flatMap((phase) =>
    diffManagedRules(phase.selectLive(live), phase.selectDesired(desired), phase.resource),
  );

  const sslChange = diffSslMode(desired.ssl.mode, live.sslMode, options.allowZoneSsl);
  // Order matters on cutover: SSL and the cache rule must be live BEFORE the
  // proxied flip, or traffic transits Cloudflare without them (Flexible-SSL
  // redirect loops would take the WebSocket host down).
  if (sslChange) changes.push(sslChange);
  changes.push(...ruleChanges);
  for (const dnsChange of dnsChanges) {
    const desiredRecord = desired.dnsRecords.find((record) => record.name === dnsChange.dnsName);
    if (!desiredRecord) throw new Error(`No desired DNS record found for planned change "${dnsChange.dnsName}"`);
    if (desiredRecord.proxied && sslChange?.blocked) {
      // Never turn the proxy on while the required SSL mode can't be applied:
      // Flexible SSL against the origin causes redirect loops on every host.
      changes.push({
        ...dnsChange,
        blocked: true,
        detail: 'Held back: zone SSL must be strict first (re-run with --allow-zone-ssl or fix the zone setting).',
      });
    } else {
      changes.push(dnsChange);
    }
  }

  return changes;
}
