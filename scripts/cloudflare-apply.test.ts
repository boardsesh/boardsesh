/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import { CACHE_RULE_DESCRIPTION, desiredCloudflareState } from '../infra/cloudflare/config';
import {
  buildPlan,
  cacheRuleMatches,
  diffCacheRule,
  diffDnsRecord,
  diffSslMode,
  jsonEqual,
  upsertCacheRule,
} from '../infra/cloudflare/plan';
import type { LiveDnsRecord, LiveState, RulesetRule } from '../infra/cloudflare/plan';
import { parseArgs } from './cloudflare-apply';

const desired = desiredCloudflareState;

function liveDnsRecord(overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord {
  return {
    id: 'dns-record-id',
    name: desired.dns.name,
    type: 'CNAME',
    content: 'boardsesh-backend.up.railway.app',
    proxied: true,
    ...overrides,
  };
}

/** A live cache rule that matches the desired rule (plus Cloudflare's read-only fields). */
function matchingLiveCacheRule(): RulesetRule {
  return {
    id: 'our-rule-id',
    version: '3',
    last_updated: '2026-07-20T00:00:00Z',
    ref: 'our-rule-ref',
    description: desired.cacheRule.description,
    expression: desired.cacheRule.expression,
    action: desired.cacheRule.action,
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'bypass_by_default' },
      browser_ttl: { mode: 'respect_origin' },
    },
    enabled: true,
  };
}

/** A foreign rule this tool must never disturb. */
function foreignRule(id: string): RulesetRule {
  return {
    id,
    version: '1',
    last_updated: '2026-01-01T00:00:00Z',
    ref: `${id}-ref`,
    description: `some other rule ${id}`,
    expression: '(http.request.uri.path eq "/graphql")',
    action: 'set_cache_settings',
    action_parameters: { cache: false },
    enabled: true,
  };
}

function inSyncLiveState(): LiveState {
  return {
    dnsRecord: liveDnsRecord(),
    cacheRules: [matchingLiveCacheRule()],
    sslMode: 'strict',
  };
}

describe('parseArgs', () => {
  it('defaults to dry-run (apply=false)', () => {
    expect(parseArgs([])).toEqual({ apply: false, allowZoneSsl: false, help: false });
  });

  it('reads --apply, --allow-zone-ssl, --help and ignores the -- separator', () => {
    expect(parseArgs(['--', '--apply', '--allow-zone-ssl'])).toEqual({
      apply: true,
      allowZoneSsl: true,
      help: false,
    });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('lets a later --dry-run override an earlier --apply', () => {
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
  });
});

describe('diffDnsRecord', () => {
  it('is a no-op when the record is already proxied', () => {
    expect(diffDnsRecord(desired.dns, liveDnsRecord({ proxied: true }))).toBeNull();
  });

  it('plans a proxied flip when the record is grey-clouded', () => {
    const change = diffDnsRecord(desired.dns, liveDnsRecord({ proxied: false }));
    expect(change).not.toBeNull();
    expect(change?.resource).toBe('dns');
    expect(change?.summary).toContain('proxied false → true');
  });
});

describe('diffSslMode (SSL weaker warning)', () => {
  it('is a no-op when already strict', () => {
    expect(diffSslMode('strict', 'strict', false)).toBeNull();
  });

  it('blocks the change when the live mode is weaker and --allow-zone-ssl is absent', () => {
    const change = diffSslMode('strict', 'full', false);
    expect(change).not.toBeNull();
    expect(change?.resource).toBe('ssl');
    expect(change?.blocked).toBe(true);
    expect(change?.summary).toContain('weaker');
  });

  it('unblocks the change when --allow-zone-ssl is given', () => {
    const change = diffSslMode('strict', 'flexible', true);
    expect(change?.blocked).toBe(false);
    expect(change?.detail).toContain('--allow-zone-ssl given');
  });

  it('flags every weaker mode (off/flexible/full)', () => {
    for (const weaker of ['off', 'flexible', 'full']) {
      expect(diffSslMode('strict', weaker, false)?.blocked).toBe(true);
    }
  });
});

describe('upsertCacheRule (foreign-rule preservation)', () => {
  it('appends our rule when the phase has none, leaving foreign rules first and untouched', () => {
    const foreignA = foreignRule('foreign-a');
    const foreignB = foreignRule('foreign-b');
    const { rules, changed } = upsertCacheRule([foreignA, foreignB], desired.cacheRule);

    expect(changed).toBe(true);
    expect(rules).toHaveLength(3);
    // Foreign rules preserved verbatim, in order, at the front.
    expect(rules[0]).toBe(foreignA);
    expect(rules[1]).toBe(foreignB);
    // Our rule appended last, carrying the marker.
    expect(rules[2].description).toBe(CACHE_RULE_DESCRIPTION);
    expect(rules[2].id).toBeUndefined();
  });

  it('is a no-op when our rule already matches', () => {
    const existing = [foreignRule('foreign-a'), matchingLiveCacheRule()];
    const { rules, changed } = upsertCacheRule(existing, desired.cacheRule);
    expect(changed).toBe(false);
    expect(rules).toBe(existing);
  });

  it('updates our rule in place — keeping its id and position — when it drifts, without touching foreign rules', () => {
    const foreignA = foreignRule('foreign-a');
    const staleOurs: RulesetRule = { ...matchingLiveCacheRule(), expression: '(http.host eq "stale")' };
    const foreignB = foreignRule('foreign-b');

    const { rules, changed } = upsertCacheRule([foreignA, staleOurs, foreignB], desired.cacheRule);

    expect(changed).toBe(true);
    expect(rules).toHaveLength(3);
    // Our rule stays at index 1, keeps its Cloudflare-assigned id, gets the desired expression.
    expect(rules[1].id).toBe('our-rule-id');
    expect(rules[1].expression).toBe(desired.cacheRule.expression);
    expect(rules[1].action_parameters).toEqual({
      cache: true,
      edge_ttl: { mode: 'bypass_by_default' },
      browser_ttl: { mode: 'respect_origin' },
    });
    // Foreign rules untouched (same references, same order).
    expect(rules[0]).toBe(foreignA);
    expect(rules[2]).toBe(foreignB);
  });
});

describe('cacheRuleMatches', () => {
  it('treats a missing enabled field as enabled', () => {
    const withoutEnabled: RulesetRule = { ...matchingLiveCacheRule() };
    delete withoutEnabled.enabled;
    expect(cacheRuleMatches(withoutEnabled, desired.cacheRule)).toBe(true);
  });

  it('detects an action_parameters difference', () => {
    const drifted: RulesetRule = { ...matchingLiveCacheRule(), action_parameters: { cache: false } };
    expect(cacheRuleMatches(drifted, desired.cacheRule)).toBe(false);
  });
});

describe('diffCacheRule', () => {
  it('is a no-op when our rule already matches', () => {
    expect(diffCacheRule([matchingLiveCacheRule()], desired.cacheRule)).toBeNull();
  });

  it('reports a create when our rule is absent', () => {
    const change = diffCacheRule([foreignRule('foreign-a')], desired.cacheRule);
    expect(change?.summary).toContain('missing');
    expect(change?.detail).toContain('1 other rule');
  });
});

describe('buildPlan', () => {
  it('returns no changes when the live zone already matches desired (no drift)', () => {
    expect(buildPlan(desired, inSyncLiveState(), { allowZoneSsl: false })).toEqual([]);
  });

  it('collects every drift (dns + cache + ssl) into one plan', () => {
    const drifted: LiveState = {
      dnsRecord: liveDnsRecord({ proxied: false }),
      cacheRules: [foreignRule('foreign-a')],
      sslMode: 'full',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    // Cutover-safe order: the proxied flip is planned last, after SSL + cache.
    expect(changes.map((change) => change.resource)).toEqual(['ssl', 'cache-rule', 'dns']);
    // The SSL change is blocked without the opt-in flag, but still reported as drift.
    expect(changes.find((change) => change.resource === 'ssl')?.blocked).toBe(true);
    // And the proxied flip is held back while the required SSL change is blocked —
    // orange-clouding with weak SSL would redirect-loop every host on the record.
    const dnsChange = changes.find((change) => change.resource === 'dns');
    expect(dnsChange?.blocked).toBe(true);
    expect(dnsChange?.detail).toContain('Held back');
  });

  it('does not hold back the proxied flip when SSL is already compliant', () => {
    const drifted: LiveState = {
      dnsRecord: liveDnsRecord({ proxied: false }),
      cacheRules: [],
      sslMode: 'strict',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    const dnsChange = changes.find((change) => change.resource === 'dns');
    expect(dnsChange?.blocked).toBeUndefined();
  });
});

describe('jsonEqual', () => {
  it('compares nested objects independent of key order', () => {
    expect(jsonEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual(null, undefined)).toBe(false);
  });
});
