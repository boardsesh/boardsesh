/// <reference types="node" />

// Pure planning logic for the Cloudflare apply tool: diff desired-vs-live and merge
// our cache rule into an existing rules array without disturbing foreign rules. No
// I/O, no globals — everything here is deterministic and unit-tested in
// scripts/cloudflare-apply.test.ts. The I/O (fetching live state, applying changes)
// lives in scripts/cloudflare-apply.ts.

import { SSL_MODE_STRENGTH, ZONE_NAME } from './config';
import type { CacheRuleDesired, DnsRecordDesired, SslDesired, SslMode } from './config';

/** A DNS record as Cloudflare returns it. We only manage `proxied`; the rest is context. */
export interface LiveDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
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
  enabled?: boolean;
  version?: string;
  last_updated?: string;
  ref?: string;
}

/** Live zone state the plan diffs against, gathered by the apply script's read phase. */
export interface LiveState {
  dnsRecord: LiveDnsRecord;
  cacheRules: RulesetRule[];
  sslMode: string;
}

export interface PlanOptions {
  /** Permit the (opt-in) zone-wide SSL mutation. When false, a weaker SSL mode is reported but not applied. */
  allowZoneSsl: boolean;
}

export interface PlannedChange {
  resource: 'dns' | 'cache-rule' | 'ssl';
  /** One-line human-readable summary of what would change. */
  summary: string;
  /** Optional extra context printed under the summary. */
  detail?: string;
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
export function cacheRuleMatches(liveRule: RulesetRule, desiredRule: CacheRuleDesired): boolean {
  return (
    liveRule.expression === desiredRule.expression &&
    liveRule.action === desiredRule.action &&
    (liveRule.enabled ?? true) === desiredRule.enabled &&
    jsonEqual(liveRule.action_parameters, desiredRule.action_parameters)
  );
}

export interface CacheRuleUpsertResult {
  /** The rules array to PUT back. Foreign rules keep their order and every field verbatim. */
  rules: RulesetRule[];
  /** Whether our rule was created or updated (false = already in the desired state). */
  changed: boolean;
}

/**
 * Merge our desired cache rule into an existing rules array. Our rule is identified
 * only by its description marker, so:
 *   - not present  → append it (create).
 *   - present, matches desired → return the array unchanged (no-op).
 *   - present, differs → replace it in place, keeping its Cloudflare-assigned id and
 *     its position; every OTHER rule is preserved verbatim.
 */
export function upsertCacheRule(existingRules: RulesetRule[], desiredRule: CacheRuleDesired): CacheRuleUpsertResult {
  const ourIndex = existingRules.findIndex((rule) => rule.description === desiredRule.description);

  if (ourIndex === -1) {
    return { rules: [...existingRules, { ...desiredRule }], changed: true };
  }

  if (cacheRuleMatches(existingRules[ourIndex], desiredRule)) {
    return { rules: existingRules, changed: false };
  }

  const existingId = existingRules[ourIndex].id;
  const replacement: RulesetRule = existingId ? { id: existingId, ...desiredRule } : { ...desiredRule };
  const rules = existingRules.slice();
  rules[ourIndex] = replacement;
  return { rules, changed: true };
}

/** Plan the DNS proxied-flag change, or null when already at the desired value. */
export function diffDnsRecord(desired: DnsRecordDesired, liveRecord: LiveDnsRecord): PlannedChange | null {
  if (liveRecord.proxied === desired.proxied) return null;
  return {
    resource: 'dns',
    summary: `DNS ${desired.name}: set proxied ${liveRecord.proxied} → ${desired.proxied}`,
    detail: `record ${liveRecord.type} ${liveRecord.name} → ${liveRecord.content} (target unchanged; only the proxied flag is managed)`,
  };
}

/** Plan the cache-rule change, or null when our rule already matches desired. */
export function diffCacheRule(existingRules: RulesetRule[], desiredRule: CacheRuleDesired): PlannedChange | null {
  const { changed } = upsertCacheRule(existingRules, desiredRule);
  if (!changed) return null;

  const alreadyPresent = existingRules.some((rule) => rule.description === desiredRule.description);
  const foreignCount = existingRules.filter((rule) => rule.description !== desiredRule.description).length;
  return {
    resource: 'cache-rule',
    summary: alreadyPresent
      ? `Cache rule "${desiredRule.description}" differs from desired — will update`
      : `Cache rule "${desiredRule.description}" missing — will create`,
    detail:
      `expression: ${desiredRule.expression}` +
      (foreignCount > 0 ? `\n    (${foreignCount} other rule(s) in this phase left untouched)` : ''),
  };
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
  desired: { dns: DnsRecordDesired; cacheRule: CacheRuleDesired; ssl: SslDesired },
  live: LiveState,
  options: PlanOptions,
): PlannedChange[] {
  const changes: PlannedChange[] = [];

  const dnsChange = diffDnsRecord(desired.dns, live.dnsRecord);

  const cacheChange = diffCacheRule(live.cacheRules, desired.cacheRule);

  const sslChange = diffSslMode(desired.ssl.mode, live.sslMode, options.allowZoneSsl);
  // Order matters on cutover: SSL and the cache rule must be live BEFORE the
  // proxied flip, or traffic transits Cloudflare without them (Flexible-SSL
  // redirect loops would take the WebSocket host down).
  if (sslChange) changes.push(sslChange);
  if (cacheChange) changes.push(cacheChange);
  if (dnsChange) {
    if (desired.dns.proxied && sslChange?.blocked) {
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
