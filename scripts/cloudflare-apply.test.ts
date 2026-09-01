/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APEX_HOSTNAME,
  APEX_ORIGINLESS_ADDRESS,
  APEX_REDIRECT_RULE_DESCRIPTION,
  ASSETS_CNAME_TARGET,
  ASSETS_HOSTNAME,
  BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION,
  BOARD_RENDER_CACHE_RULE_DESCRIPTION,
  CACHE_RULE_DESCRIPTION,
  CRAWLER_ALLOW_RULE_DESCRIPTION,
  CRAWLER_ALLOW_TOKENS,
  CRAWLER_BLOCK_RULE_DESCRIPTION,
  CRAWLER_BLOCK_TOKENS,
  CLIMB_VIEW_RATE_LIMIT_RULE_DESCRIPTION,
  DYNAMIC_REDIRECT_RULE_PHASE,
  RATE_LIMIT_RULE_PHASE,
  WWW_HOSTNAME,
  WWW_RAILWAY_CNAME_TARGET,
  WS_HOSTNAME,
  desiredCloudflareState,
} from '../infra/cloudflare/config';
import type { DnsRecordDesired, FullyManagedDnsRecordDesired } from '../infra/cloudflare/config';
import {
  MANAGED_RULE_PHASES,
  buildPlan,
  cacheRuleMatches,
  diffCacheRule,
  diffManagedRules,
  diffDnsRecord,
  diffSslMode,
  jsonEqual,
  resolveRulePhase,
  upsertCacheRule,
} from '../infra/cloudflare/plan';
import type { LiveDnsRecord, LiveState, RulesetRule } from '../infra/cloudflare/plan';
import {
  MANAGED_DNS_RECORD_TYPES,
  SHARED_TOKEN_SCOPES,
  TOKEN_SCOPES,
  fullyManagedDnsBody,
  parseArgs,
  runCloudflareApply,
  selectManagedDnsRecord,
} from './cloudflare-apply';

const desired = desiredCloudflareState;

function requiredDnsRecord(name: string): DnsRecordDesired {
  const record = desired.dnsRecords.find((candidate) => candidate.name === name);
  if (!record) throw new Error(`Expected ${name} in desired Cloudflare DNS state`);
  return record;
}

function requiredFullyManagedDnsRecord(name: string): FullyManagedDnsRecordDesired {
  const record = requiredDnsRecord(name);
  if (record.management !== 'full') throw new Error(`Expected ${name} to be fully managed`);
  return record;
}

const wsDnsRecord = requiredDnsRecord(WS_HOSTNAME);
const assetsDnsRecord = requiredFullyManagedDnsRecord(ASSETS_HOSTNAME);
const wwwDnsRecord = requiredFullyManagedDnsRecord(WWW_HOSTNAME);
const apexDnsRecord = requiredFullyManagedDnsRecord(APEX_HOSTNAME);
/** The og cache rule — the one the pre-existing cases in this file were written against. */
const ogCacheRule = desired.cacheRules[0];

function liveDnsRecord(overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord {
  return {
    id: 'dns-record-id',
    name: wsDnsRecord.name,
    type: 'CNAME',
    content: 'boardsesh-backend.up.railway.app',
    ttl: 1,
    proxied: true,
    ...overrides,
  };
}

/** www as Cloudflare returns it once converged: a proxied CNAME to the Railway web service (#4655). */
function liveWwwDnsRecord(overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord {
  return {
    id: 'www-dns-record-id',
    name: WWW_HOSTNAME,
    type: wwwDnsRecord.type,
    content: wwwDnsRecord.content,
    ttl: wwwDnsRecord.ttl,
    proxied: wwwDnsRecord.proxied,
    ...overrides,
  };
}

/** The apex once converged: the same A record, now proxied and originless. */
function liveApexDnsRecord(overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord {
  return {
    id: 'apex-dns-record-id',
    name: APEX_HOSTNAME,
    type: apexDnsRecord.type,
    content: apexDnsRecord.content,
    ttl: apexDnsRecord.ttl,
    proxied: apexDnsRecord.proxied,
    ...overrides,
  };
}

/** The apex as it stands BEFORE this change: a DNS-only A record to Vercel. */
function liveVercelApexDnsRecord(): LiveDnsRecord {
  return liveApexDnsRecord({ type: 'A', content: '76.76.21.21', proxied: false });
}

function liveAssetsDnsRecord(overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord {
  return {
    id: 'assets-dns-record-id',
    name: assetsDnsRecord.name,
    type: assetsDnsRecord.type,
    content: assetsDnsRecord.content,
    ttl: assetsDnsRecord.ttl,
    proxied: assetsDnsRecord.proxied,
    settings: assetsDnsRecord.settings,
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
    description: ogCacheRule.description,
    expression: ogCacheRule.expression,
    action: ogCacheRule.action,
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

/** Live copies of every managed rule, matching desired (plus Cloudflare's read-only fields). */
function matchingLiveRules(
  desiredRules: readonly {
    description: string;
    expression: string;
    action: string;
    action_parameters?: unknown;
    // Carried through so a rate-limit rule can be "in sync" in a fixture at all:
    // its threshold lives here, and cacheRuleMatches compares it.
    ratelimit?: unknown;
  }[],
): RulesetRule[] {
  return desiredRules.map((rule, index) => ({
    id: `our-rule-id-${index}`,
    version: '3',
    last_updated: '2026-07-20T00:00:00Z',
    ref: `our-rule-ref-${index}`,
    description: rule.description,
    expression: rule.expression,
    action: rule.action,
    action_parameters: rule.action_parameters,
    ratelimit: rule.ratelimit,
    enabled: true,
  }));
}

/**
 * Live rules for every REGISTERED phase, keyed off MANAGED_RULE_PHASES rather
 * than a literal per phase. A phase added to the registry without a fixture here
 * would otherwise leave its key missing and every buildPlan test reading
 * `undefined` for it.
 */
function rulesForEveryPhase(
  select: (phase: (typeof MANAGED_RULE_PHASES)[number]) => RulesetRule[],
): LiveState['rules'] {
  return Object.fromEntries(MANAGED_RULE_PHASES.map((phase) => [phase.resource, select(phase)])) as LiveState['rules'];
}

/** Every managed rule present and matching. */
function inSyncRules(): LiveState['rules'] {
  return rulesForEveryPhase((phase) => matchingLiveRules([...phase.selectDesired(desired)]));
}

/** No rules anywhere — a zone that has never carried any of our phases. */
function emptyRules(): LiveState['rules'] {
  return rulesForEveryPhase(() => []);
}

function inSyncDnsRecords(): LiveState['dnsRecords'] {
  return {
    [wsDnsRecord.name]: liveDnsRecord(),
    [assetsDnsRecord.name]: liveAssetsDnsRecord(),
    [wwwDnsRecord.name]: liveWwwDnsRecord(),
    [apexDnsRecord.name]: liveApexDnsRecord(),
  };
}

function inSyncLiveState(): LiveState {
  return {
    dnsRecords: inSyncDnsRecords(),
    rules: inSyncRules(),
    sslMode: 'strict',
    flattenAllCnames: false,
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
    expect(diffDnsRecord(wsDnsRecord, liveDnsRecord({ proxied: true }))).toBeNull();
  });

  it('plans a proxied flip when the record is grey-clouded', () => {
    const change = diffDnsRecord(wsDnsRecord, liveDnsRecord({ proxied: false }));
    expect(change).not.toBeNull();
    expect(change?.resource).toBe('dns');
    expect(change?.dnsName).toBe(WS_HOSTNAME);
    expect(change?.summary).toContain('proxied false → true');
  });

  it('does not take ownership of the existing ws record target, type, or TTL', () => {
    expect(
      diffDnsRecord(wsDnsRecord, liveDnsRecord({ type: 'A', content: '203.0.113.10', ttl: 300, proxied: true })),
    ).toBeNull();
  });

  it('fails closed when the proxy-only ws record is missing', () => {
    expect(() => diffDnsRecord(wsDnsRecord, null)).toThrow('proxy-only managed');
  });

  it('plans creation of the fully managed assets record when it is missing', () => {
    const change = diffDnsRecord(assetsDnsRecord, null);
    expect(change).toMatchObject({
      resource: 'dns',
      dnsName: ASSETS_HOSTNAME,
      summary: expect.stringContaining('missing — will create'),
    });
    expect(change?.detail).toContain(ASSETS_CNAME_TARGET);
    expect(change?.detail).toContain('ttl automatic');
    expect(change?.detail).toContain('proxied false');
    expect(change?.detail).toContain('CNAME flattening disabled');
  });

  it('is a no-op when every owned assets field matches', () => {
    expect(diffDnsRecord(assetsDnsRecord, liveAssetsDnsRecord())).toBeNull();
  });

  it('plans correction of every owned assets field when it drifts', () => {
    const change = diffDnsRecord(
      assetsDnsRecord,
      liveAssetsDnsRecord({ type: 'A', content: 'old.example.com', ttl: 300, proxied: true }),
    );
    expect(change?.summary).toContain('managed fields differ — will update');
    expect(change?.detail).toContain('type A → CNAME');
    expect(change?.detail).toContain(`content old.example.com → ${ASSETS_CNAME_TARGET}`);
    expect(change?.detail).toContain('ttl 300 → automatic');
    expect(change?.detail).toContain('proxied true → false');
  });

  it('plans disabling per-record CNAME flattening when it drifts', () => {
    const change = diffDnsRecord(assetsDnsRecord, liveAssetsDnsRecord({ settings: { flatten_cname: true } }));

    expect(change?.detail).toContain('flatten_cname true → false');
  });

  it('reports explicit desired TTLs without calling them automatic', () => {
    const explicitTtl = { ...assetsDnsRecord, ttl: 300 };
    const change = diffDnsRecord(explicitTtl, liveAssetsDnsRecord({ ttl: 1 }));

    expect(change?.detail).toContain('ttl automatic → 300');
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
    const { rules, changed } = upsertCacheRule([foreignA, foreignB], ogCacheRule);

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
    const { rules, changed } = upsertCacheRule(existing, ogCacheRule);
    expect(changed).toBe(false);
    expect(rules).toBe(existing);
  });

  it('updates our rule in place — keeping its id and position — when it drifts, without touching foreign rules', () => {
    const foreignA = foreignRule('foreign-a');
    const staleOurs: RulesetRule = { ...matchingLiveCacheRule(), expression: '(http.host eq "stale")' };
    const foreignB = foreignRule('foreign-b');

    const { rules, changed } = upsertCacheRule([foreignA, staleOurs, foreignB], ogCacheRule);

    expect(changed).toBe(true);
    expect(rules).toHaveLength(3);
    // Our rule stays at index 1, keeps its Cloudflare-assigned id, gets the desired expression.
    expect(rules[1].id).toBe('our-rule-id');
    expect(rules[1].expression).toBe(ogCacheRule.expression);
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
    expect(cacheRuleMatches(withoutEnabled, ogCacheRule)).toBe(true);
  });

  it('detects an action_parameters difference', () => {
    const drifted: RulesetRule = { ...matchingLiveCacheRule(), action_parameters: { cache: false } };
    expect(cacheRuleMatches(drifted, ogCacheRule)).toBe(false);
  });
});

describe('diffCacheRule', () => {
  it('is a no-op when our rule already matches', () => {
    expect(diffCacheRule([matchingLiveCacheRule()], ogCacheRule)).toBeNull();
  });

  it('reports a create when our rule is absent', () => {
    const change = diffCacheRule([foreignRule('foreign-a')], ogCacheRule);
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
      ...inSyncLiveState(),
      dnsRecords: { ...inSyncDnsRecords(), [wsDnsRecord.name]: liveDnsRecord({ proxied: false }) },
      rules: { ...inSyncRules(), 'cache-rule': [foreignRule('foreign-a')] },
      sslMode: 'full',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    // Cutover-safe order: the proxied flip is planned last, after SSL + the rules.
    // All three cache rules are missing (the phase holds only a foreign rule), and the
    // WAF phase is already in sync, so it contributes nothing.
    expect(changes.map((change) => change.resource)).toEqual(['ssl', 'cache-rule', 'cache-rule', 'cache-rule', 'dns']);
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
      ...inSyncLiveState(),
      dnsRecords: { ...inSyncDnsRecords(), [wsDnsRecord.name]: liveDnsRecord({ proxied: false }) },
      rules: emptyRules(),
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    const dnsChange = changes.find((change) => change.resource === 'dns');
    expect(dnsChange?.blocked).toBeUndefined();
  });

  it('plans multiple DNS records independently and does not SSL-block a DNS-only create', () => {
    const drifted: LiveState = {
      ...inSyncLiveState(),
      dnsRecords: {
        ...inSyncDnsRecords(),
        [wsDnsRecord.name]: liveDnsRecord({ proxied: false }),
        [assetsDnsRecord.name]: null,
      },
      sslMode: 'full',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    const dnsChanges = changes.filter((change) => change.resource === 'dns');

    expect(dnsChanges.map((change) => change.dnsName)).toEqual([WS_HOSTNAME, ASSETS_HOSTNAME]);
    expect(dnsChanges.find((change) => change.dnsName === WS_HOSTNAME)?.blocked).toBe(true);
    expect(dnsChanges.find((change) => change.dnsName === ASSETS_HOSTNAME)?.blocked).toBeUndefined();
  });

  it('fails closed when zone-wide flattening would hide the Tigris verification CNAME', () => {
    const flattenedZone: LiveState = { ...inSyncLiveState(), flattenAllCnames: true };

    expect(() => buildPlan(desired, flattenedZone, { allowZoneSsl: false })).toThrow('Disable "Flatten all CNAMEs"');
  });
});

describe('assets.boardsesh.com desired state', () => {
  it('declares the exact DNS-only Tigris CNAME with automatic TTL', () => {
    expect(assetsDnsRecord).toEqual({
      management: 'full',
      name: 'assets.boardsesh.com',
      type: 'CNAME',
      content: 'boardsesh-static-assets.t3.tigrisbucket.io',
      ttl: 1,
      proxied: false,
      settings: {
        flatten_cname: false,
      },
    });
  });

  it('writes the complete Cloudflare create/update body including the anti-flattening guard', () => {
    expect(fullyManagedDnsBody(assetsDnsRecord)).toEqual({
      type: 'CNAME',
      name: 'assets.boardsesh.com',
      content: 'boardsesh-static-assets.t3.tigrisbucket.io',
      ttl: 1,
      proxied: false,
      settings: {
        flatten_cname: false,
      },
    });
  });

  it('keeps DNS record identities unique and adds no assets cache rule', () => {
    expect(new Set(desired.dnsRecords.map((record) => record.name)).size).toBe(desired.dnsRecords.length);
    expect(desired.cacheRules.every((rule) => !rule.expression.includes(ASSETS_HOSTNAME))).toBe(true);
  });
});

describe('www.boardsesh.com under Cloudflare management (#4655)', () => {
  it('is a fully managed proxied CNAME to the Railway web service', () => {
    // Landed here first as `management: 'proxied-only'` (target left to the
    // dashboard, same boundary as ws) so the origin flip could be a reviewable
    // diff instead of a dashboard click. This PR is that flip: `management: 'full'`
    // now owns type, content and TTL too.
    expect(wwwDnsRecord).toEqual({
      management: 'full',
      name: WWW_HOSTNAME,
      type: 'CNAME',
      content: WWW_RAILWAY_CNAME_TARGET,
      ttl: 1,
      proxied: true,
    });
  });

  it('is a proxied CNAME to a Railway host, not Vercel', () => {
    // Read directly off the desired state rather than a fixture, so pointing
    // `content` back at a Vercel target — by accident, or a bad revert — fails
    // this test instead of passing silently.
    expect(wwwDnsRecord.type).toBe('CNAME');
    expect(wwwDnsRecord.proxied).toBe(true);
    expect(wwwDnsRecord.content).toMatch(/\.up\.railway\.app$/);
  });

  it('sends the exact CNAME body Cloudflare needs, without a flatten_cname setting', () => {
    // `management: 'full'` has to be able to express a PROXIED CNAME, or the
    // flip would still be a dashboard click. Owning `content` is what makes it
    // reviewable and revertable.
    expect(fullyManagedDnsBody(wwwDnsRecord)).toEqual({
      type: 'CNAME',
      name: WWW_HOSTNAME,
      content: WWW_RAILWAY_CNAME_TARGET,
      ttl: 1,
      proxied: true,
    });
    // `settings` is omitted, not sent as false: Cloudflare always flattens a
    // proxied CNAME, so flatten_cname is not ours to set on this record.
    expect('settings' in fullyManagedDnsBody(wwwDnsRecord)).toBe(false);
  });

  it('is zero drift once the live record already matches Railway', () => {
    expect(diffDnsRecord(wwwDnsRecord, liveWwwDnsRecord())).toBeNull();
  });

  it('plans the flip when the live record still points at Vercel', () => {
    // What `deploy-cloudflare` actually does on merge: the zone still answers
    // with the Vercel CNAME until the apply PATCHes it onto Railway.
    const change = diffDnsRecord(wwwDnsRecord, liveWwwDnsRecord({ content: 'cname.vercel-dns.com' }));
    expect(change?.summary).toContain('managed fields differ — will update');
    expect(change?.detail).toContain(`content cname.vercel-dns.com → ${WWW_RAILWAY_CNAME_TARGET}`);
  });

  it('plans the orange cloud back on if www is ever grey-clouded', () => {
    const change = diffDnsRecord(wwwDnsRecord, liveWwwDnsRecord({ proxied: false }));
    expect(change?.dnsName).toBe(WWW_HOSTNAME);
    expect(change?.summary).toContain('managed fields differ — will update');
    expect(change?.detail).toContain('proxied false → true');
  });

  it('plans creation of the www record if it is ever missing', () => {
    const change = diffDnsRecord(wwwDnsRecord, null);
    expect(change).toMatchObject({
      resource: 'dns',
      dnsName: WWW_HOSTNAME,
      summary: expect.stringContaining('missing — will create'),
    });
    expect(change?.detail).toContain(WWW_RAILWAY_CNAME_TARGET);
  });

  it('does not put a proxied CNAME behind the zone-wide flattening guard', () => {
    // That guard exists for the DNS-only Tigris CNAME, whose literal answer has
    // to stay visible. A proxied record is flattened by Cloudflare no matter
    // what, so a zone with "Flatten all CNAMEs" on must not fail the www apply.
    const wwwOnly = {
      dnsRecords: [wwwDnsRecord],
      cacheRules: [],
      wafRules: [],
      rateLimitRules: [],
      redirectRules: [],
      ssl: desired.ssl,
    };
    const flattenedZone: LiveState = {
      dnsRecords: { [WWW_HOSTNAME]: liveWwwDnsRecord() },
      rules: emptyRules(),
      sslMode: 'strict',
      flattenAllCnames: true,
    };

    expect(buildPlan(wwwOnly, flattenedZone, { allowZoneSsl: false })).toEqual([]);
  });
});

describe('selectManagedDnsRecord', () => {
  const recordAt = (type: string, content: string, overrides: Partial<LiveDnsRecord> = {}): LiveDnsRecord => ({
    id: `${type}-id`,
    name: WWW_HOSTNAME,
    type,
    content,
    ttl: 1,
    proxied: true,
    ...overrides,
  });

  it('ignores the non-address records Cloudflare returns for the same name', () => {
    // The lookup is by name and Cloudflare answers with every type at it. The
    // apex carries MX/TXT/CAA as a matter of course, and treating those as
    // candidates would fail the whole apply with "ambiguous" on an ordinary zone.
    const records = [
      recordAt('TXT', 'v=spf1 -all'),
      recordAt('MX', 'mx.example.com'),
      recordAt('CNAME', 'cname.vercel-dns.com'),
      recordAt('CAA', '0 issue "letsencrypt.org"'),
    ];

    expect(selectManagedDnsRecord(records, WWW_HOSTNAME)?.type).toBe('CNAME');
    expect(MANAGED_DNS_RECORD_TYPES).toEqual(['A', 'AAAA', 'CNAME']);
  });

  it('still refuses to guess between two address records at one name', () => {
    expect(() =>
      selectManagedDnsRecord([recordAt('A', '203.0.113.1'), recordAt('AAAA', '2001:db8::1')], WWW_HOSTNAME),
    ).toThrow('ambiguous');
  });

  it('ignores a different name, and reports absence as null', () => {
    const elsewhere = recordAt('A', '203.0.113.1', { name: 'other.boardsesh.com' });
    expect(selectManagedDnsRecord([elsewhere], WWW_HOSTNAME)).toBeNull();
    expect(selectManagedDnsRecord([], WWW_HOSTNAME)).toBeNull();
  });
});

describe('parseArgs strictness', () => {
  it('rejects unknown flags instead of silently dry-running', () => {
    expect(() => parseArgs(['--appply'])).toThrow('Unknown flag: --appply');
  });
});

describe('diffSslMode with an unrecognized live mode', () => {
  it('treats an unknown mode as drift needing a change', () => {
    const change = diffSslMode('strict', 'mystery_mode', false);
    expect(change).not.toBeNull();
    expect(change?.blocked).toBe(true);
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

describe('www cost-control rules (#4650)', () => {
  const boardRenderRule = desired.cacheRules.find((rule) => rule.description === BOARD_RENDER_CACHE_RULE_DESCRIPTION);
  const backendBoardRenderRule = desired.cacheRules.find(
    (rule) => rule.description === BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION,
  );
  const allowRule = desired.wafRules.find((rule) => rule.description === CRAWLER_ALLOW_RULE_DESCRIPTION);
  const blockRule = desired.wafRules.find((rule) => rule.description === CRAWLER_BLOCK_RULE_DESCRIPTION);

  it('scopes the board-render cache rule to www and the render path', () => {
    // Cloudflare caches by file extension by default and this path has none, which
    // is the entire reason the route measured cf-cache-status: DYNAMIC despite
    // sending `immutable, max-age=31536000`.
    expect(boardRenderRule?.expression).toBe(
      `(http.host eq "${WWW_HOSTNAME}" and starts_with(http.request.uri.path, "/api/internal/board-render"))`,
    );
    expect(boardRenderRule?.action_parameters.cache).toBe(true);
    // A 503 from the render semaphore sends no cacheable Cache-Control; bypassing
    // by default is what keeps load-shed responses out of the edge cache.
    expect(boardRenderRule?.action_parameters.edge_ttl.mode).toBe('bypass_by_default');
  });

  it('caches the canonical and released Live Activity board-render paths on ws', () => {
    expect(backendBoardRenderRule?.expression).toBe(
      `(http.host eq "${WS_HOSTNAME}" and (http.request.uri.path eq "/render/board" or http.request.uri.path eq "/api/internal/board-render"))`,
    );
    expect(backendBoardRenderRule?.action_parameters.cache).toBe(true);
    expect(backendBoardRenderRule?.action_parameters.edge_ttl.mode).toBe('bypass_by_default');
    expect(backendBoardRenderRule?.action_parameters.browser_ttl.mode).toBe('respect_origin');
  });

  it('keeps all three cache rules separately addressable', () => {
    // Identity is the description marker; a duplicate would make the upsert treat
    // one rule as the other and silently drop it.
    expect(new Set(desired.cacheRules.map((rule) => rule.description)).size).toBe(desired.cacheRules.length);
    expect(CACHE_RULE_DESCRIPTION).not.toBe(BOARD_RENDER_CACHE_RULE_DESCRIPTION);
    expect(BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION).not.toBe(BOARD_RENDER_CACHE_RULE_DESCRIPTION);
    expect(BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION).not.toBe(CACHE_RULE_DESCRIPTION);
  });

  it('lowercases the user agent in every WAF expression', () => {
    // Cloudflare's `contains` is CASE-SENSITIVE. Without lower(), the rule installs
    // cleanly and matches nothing — the worst kind of failure, because it looks done.
    for (const rule of desired.wafRules) {
      const comparisons = rule.expression.split(' or ');
      expect(comparisons.length).toBeGreaterThan(0);
      for (const comparison of comparisons) {
        expect(comparison).toMatch(/^lower\(http\.user_agent\) contains "[^A-Z]*"$/);
      }
    }
  });

  it('never blocks a search engine or unfurler we allow', () => {
    // The real hazard of a token list: one short token catching a crawler we depend
    // on. Checked against full UA strings, not just the tokens.
    const allowedUserAgents = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; Googlebot-Image/1.0; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; Brave-Search/1.0; +https://search.brave.com/help/brave-search-crawler)',
      'Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
    ];
    for (const userAgent of allowedUserAgents) {
      for (const token of CRAWLER_BLOCK_TOKENS) {
        expect(userAgent.toLowerCase()).not.toContain(token);
      }
    }
  });

  it('matches the scrapers it is meant to block', () => {
    const blockedUserAgents = [
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
      'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)',
      'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
      'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot;)',
      'Screaming Frog SEO Spider/21.4',
    ];
    for (const userAgent of blockedUserAgents) {
      const matched = CRAWLER_BLOCK_TOKENS.some((token) => userAgent.toLowerCase().includes(token));
      expect(matched, `${userAgent} must be blocked`).toBe(true);
    }
  });

  it('never lists the same token as both allowed and blocked', () => {
    for (const blockToken of CRAWLER_BLOCK_TOKENS) {
      for (const allowToken of CRAWLER_ALLOW_TOKENS) {
        expect(blockToken.includes(allowToken) || allowToken.includes(blockToken)).toBe(false);
      }
    }
  });

  it('declares the allow rule before the block rule', () => {
    // Precedence is the whole safety mechanism: skip-remaining only protects a
    // crawler if it is evaluated first.
    expect(desired.wafRules.indexOf(allowRule!)).toBeLessThan(desired.wafRules.indexOf(blockRule!));
    expect(allowRule?.action).toBe('skip');
    expect(allowRule?.action_parameters).toEqual({ ruleset: 'current' });
    expect(blockRule?.action).toBe('block');
  });
});

describe('managed rule ordering and foreign-rule safety', () => {
  const liveRule = (description: string, extra: Partial<RulesetRule> = {}): RulesetRule => ({
    id: `${description}-id`,
    version: '2',
    description,
    expression: 'lower(http.user_agent) contains "stale"',
    action: 'block',
    enabled: true,
    ...extra,
  });

  it('puts a newly added allow rule BEFORE an already-present block rule', () => {
    // The regression this exists for. A rule-by-rule upsert would append the new
    // allow rule after the existing block rule, reversing precedence and blocking
    // Googlebot the moment the config landed.
    const existing = [liveRule(CRAWLER_BLOCK_RULE_DESCRIPTION)];
    const { rules, changed } = upsertCacheRule(existing, desired.wafRules);

    expect(changed).toBe(true);
    expect(rules.map((rule) => rule.description)).toEqual([
      CRAWLER_ALLOW_RULE_DESCRIPTION,
      CRAWLER_BLOCK_RULE_DESCRIPTION,
    ]);
    // The pre-existing rule keeps its Cloudflare-assigned id rather than being
    // recreated, so its analytics and history survive.
    expect(rules[1].id).toBe(`${CRAWLER_BLOCK_RULE_DESCRIPTION}-id`);
  });

  it('reports an out-of-order group as drift even when each rule matches', () => {
    const reversed = [...desired.wafRules].reverse().map((rule) => ({ ...rule, id: `${rule.description}-id` }));
    const changes = diffManagedRules(reversed, desired.wafRules, 'waf-rule');

    expect(changes).toHaveLength(1);
    expect(changes[0].summary).toContain('out of order');
  });

  it('preserves foreign WAF rules, including the AI-crawler block', () => {
    // The rulesets API PUT replaces the whole phase. Cloudflare 403s ClaudeBot,
    // GPTBot and friends via a rule we do not own; dropping it here would quietly
    // reopen the site to every AI scraper.
    const aiBlock = liveRule('cloudflare-managed: block AI crawlers');
    const other = liveRule('some other custom rule');
    const { rules } = upsertCacheRule([aiBlock, other], desired.wafRules);

    expect(rules).toContain(aiBlock);
    expect(rules).toContain(other);
    expect(rules).toHaveLength(2 + desired.wafRules.length);
    // Foreign rules keep their position ahead of ours, so an existing block still
    // runs first.
    expect(rules.slice(0, 2)).toEqual([aiBlock, other]);
  });

  it('is a no-op when the phase already matches', () => {
    const inSync = desired.wafRules.map((rule, index) => ({ id: `id-${index}`, ...rule }));
    const { rules, changed } = upsertCacheRule(inSync, desired.wafRules);

    expect(changed).toBe(false);
    expect(rules).toBe(inSync);
    expect(diffManagedRules(inSync, desired.wafRules, 'waf-rule')).toEqual([]);
  });
});

describe('deploy-cloudflare workflow wiring', () => {
  const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
  const webJob = workflow.slice(workflow.indexOf('  deploy-web:'), workflow.indexOf('  deploy-production-backend:'));
  const cloudflareJob = workflow.slice(workflow.indexOf('  deploy-cloudflare:'), workflow.indexOf('  deploy-app-web:'));
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply Cloudflare config'),
    workflow.indexOf('deploy-app-web:'),
  );

  it('never hard-codes --allow-zone-ssl into the apply command', () => {
    // The zone-wide SSL/TLS mode affects every hostname on boardsesh.com — ws,
    // app and www. A routine merge must not be able to change it; only a
    // deliberate manual dispatch can.
    expect(applyStep).toContain('vp run cf:apply -- --apply $ALLOW_ZONE_SSL');
    expect(applyStep).not.toMatch(/run:.*--apply\s+--allow-zone-ssl/);
  });

  it('gates the flag on a workflow_dispatch input, so a push resolves it to empty', () => {
    // `inputs` is null on a push event, so the expression falls through to ''.
    // If this were ever keyed on a repo variable or a secret instead, every
    // merge would start applying zone-wide SSL changes silently.
    expect(applyStep).toMatch(
      /ALLOW_ZONE_SSL: \$\{\{ inputs\.cloudflare_allow_zone_ssl && '--allow-zone-ssl' \|\| '' \}\}/,
    );
  });

  it('declares the input as a boolean defaulting to off', () => {
    const dispatchBlock = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('concurrency:'));
    expect(dispatchBlock).toContain('cloudflare_allow_zone_ssl:');
    expect(dispatchBlock).toContain('type: boolean');
    expect(dispatchBlock).toContain('default: false');
  });

  it('parses the exact argv the workflow produces, both with and without the flag', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, allowZoneSsl: false, help: false });
    expect(parseArgs(['--apply', '--allow-zone-ssl'])).toEqual({ apply: true, allowZoneSsl: true, help: false });
  });

  it('converges Cloudflare before publishing assets when both targets change', () => {
    const syncJobStart = workflow.indexOf('  sync-static-assets:');
    const buildWebStart = workflow.indexOf('  build-web:');
    expect(syncJobStart).toBeGreaterThan(-1);
    expect(buildWebStart).toBeGreaterThan(syncJobStart);
    const syncJob = workflow.slice(syncJobStart, buildWebStart);

    expect(syncJob).toContain('needs: [detect-changes, deploy-cloudflare]');
    expect(syncJob).toContain('always()');
    const syncJobCondition = syncJob.slice(0, syncJob.indexOf('    runs-on:'));
    expect(syncJobCondition).not.toContain('needs.deploy-cloudflare.result');
    const prerequisiteStep = syncJob.slice(
      syncJob.indexOf('      - name: Require successful Cloudflare prerequisite'),
      syncJob.indexOf('      - uses: actions/checkout@v6'),
    );
    expect(prerequisiteStep).toContain('CLOUDFLARE_DEPLOY_RESULT: ${{ needs.deploy-cloudflare.result }}');
    expect(prerequisiteStep).toContain('success|skipped)');
    expect(prerequisiteStep).toContain('exit 1');
  });

  it('applies Cloudflare independently, then promotes web after both it and Railway succeed', () => {
    expect(cloudflareJob).toContain('needs: [detect-changes]');
    expect(cloudflareJob).not.toContain('needs.deploy-production-backend');
    expect(webJob).toContain('deploy-production-backend,');
    expect(webJob).toContain('deploy-cloudflare');
    expect(webJob).toContain("needs.deploy-cloudflare.result == 'success'");
  });

  it('holds the Railway web deploy behind the same Cloudflare apply', () => {
    // The container deploy is the other half of the same promotion: an edge
    // config that has not converged is just as wrong in front of Railway as in
    // front of Vercel, and this job is the one that survives the Vercel scrub.
    const railwayWebJob = workflow.slice(
      workflow.indexOf('  deploy-web-railway:'),
      workflow.indexOf('  deploy-cloudflare:'),
    );
    expect(railwayWebJob).toContain('deploy-cloudflare');
    expect(railwayWebJob).toContain("needs.deploy-cloudflare.result == 'success'");
  });
});

describe('token scope guidance', () => {
  // printTokenScopes() is the only place a maintainer sees these lists, so they
  // have to keep pace with the requests the tool makes — and with the other job
  // reading the same Production-environment CLOUDFLARE_API_TOKEN.
  it('names every zone permission the tool calls', () => {
    // One entry per request, reads included: a token missing a read scope fails
    // just as hard as one missing a write. Zone.WAF Edit went missing from this
    // list once while the crawler rules depended on it, so a partially-converged
    // zone was the failure mode rather than a clean error.
    const printed = TOKEN_SCOPES.join('\n');
    expect(printed).toContain('Zone.Zone Read'); // GET /zones?name= (resolve the zone id)
    expect(printed).toContain('Zone.DNS Edit'); // PATCH ws; create/update the assets CNAME
    expect(printed).toContain('Zone.Cache Rules Edit'); // PUT the cache-settings phase
    expect(printed).toContain('Zone.WAF Edit'); // PUT the firewall-custom phase
    expect(printed).toContain('Zone.Rate Limit Edit'); // PUT the http_ratelimit phase
    expect(printed).toContain('Zone.Zone Settings Read'); // GET /settings/ssl
    expect(printed).toContain('Zone.Zone Settings Edit'); // PATCH /settings/ssl
  });

  it('keeps the Pages scope deploy-app-web needs, and marks it Account-level', () => {
    // The `Account.` prefix is the load-bearing part, not decoration. Cloudflare's
    // permission picker is grouped by resource type, and Cloudflare Pages appears
    // ONLY under Account — never under the zone/domain group where the rest of
    // this token's scopes live. Searching the domain section for it turns up
    // Custom Pages, Page Shield and Page Rules, none of which is Pages, and the
    // resulting token fails `wrangler pages deploy` with
    // Authentication error [code: 10000] while `wrangler whoami` still succeeds.
    expect(SHARED_TOKEN_SCOPES.join('\n')).toContain('Account.Cloudflare Pages Edit');
  });

  it('holds scopes, not prose, so the printed columns stay aligned', () => {
    // Guards shape rather than wording: an explanation parked in either array
    // prints ragged against the indent, and a blank spacer entry prints as
    // trailing whitespace. Reasons belong in comments above the list.
    for (const scope of [...TOKEN_SCOPES, ...SHARED_TOKEN_SCOPES]) {
      expect(scope).toMatch(/^(Zone|Account)\.\S/);
      expect(scope).toContain('—');
    }
  });
});

describe('managed ruleset phases', () => {
  // The bug this registry exists to prevent: the read, the diff and the apply
  // each named the phases independently, and the apply's if/else chain had no
  // else. A third phase wired into two of the three produced a dry-run that
  // reported drift and an apply that wrote nothing while logging "applied".

  it('registers a distinct phase and resource for every managed rule kind', () => {
    const resources = MANAGED_RULE_PHASES.map((phase) => phase.resource);
    const phases = MANAGED_RULE_PHASES.map((phase) => phase.phase);
    expect(new Set(resources).size).toBe(MANAGED_RULE_PHASES.length);
    expect(new Set(phases).size).toBe(MANAGED_RULE_PHASES.length);
    expect(phases).toContain(RATE_LIMIT_RULE_PHASE);
  });

  it('resolves every registered resource, and throws rather than skipping an unknown one', () => {
    for (const phase of MANAGED_RULE_PHASES) {
      expect(resolveRulePhase(phase.resource)).toBe(phase);
    }
    // The mutant this kills: returning undefined (or falling through) here is
    // what made the old apply loop silently skip a whole phase.
    expect(() => resolveRulePhase('nope' as (typeof MANAGED_RULE_PHASES)[number]['resource'])).toThrowError(
      /No managed ruleset phase registered/,
    );
  });

  it('plans a change for drift in EVERY registered phase, not just the first two', () => {
    // Walks the registry rather than naming phases, so a phase added later is
    // covered by this test the day it is added.
    for (const phase of MANAGED_RULE_PHASES) {
      const live = inSyncLiveState();
      // Empty this one phase; every other phase stays in sync.
      const drifted: LiveState = { ...live, rules: { ...live.rules, [phase.resource]: [] } };
      const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
      expect(
        changes.some((change) => change.resource === phase.resource),
        `${phase.resource} drift produced no planned change`,
      ).toBe(true);
    }
  });

  it('preserves foreign rules in every phase, including a foreign rate-limit rule', () => {
    // The PUT replaces the whole phase, so anything not merged through is deleted.
    for (const phase of MANAGED_RULE_PHASES) {
      const foreign = foreignRule(`foreign-${phase.resource}`);
      const { rules } = upsertCacheRule([foreign], [...phase.selectDesired(desired)]);
      expect(rules).toContain(foreign);
      expect(rules).toHaveLength(1 + phase.selectDesired(desired).length);
    }
  });
});

describe('climb-view rate-limit rule', () => {
  const rateLimitRule = desired.rateLimitRules.find(
    (rule) => rule.description === CLIMB_VIEW_RATE_LIMIT_RULE_DESCRIPTION,
  );

  it('is declared, and blocks — the only action the Free plan allows', () => {
    // `log` is Enterprise-only and this zone is Free/Pro, so `managed_challenge`
    // is the gentlest action available: a real browser passes it transparently,
    // a headless crawler mostly does not. Shipping straight to `block` on a
    // guessed threshold would throttle a gym full of climbers behind one NAT.
    expect(rateLimitRule).toBeDefined();
    expect(rateLimitRule?.action).toBe('block');
    expect(rateLimitRule?.enabled).toBe(true);
  });

  it('keeps the mitigation timeout within the Free-plan ceiling', () => {
    // mitigation_timeout below Business is capped at 10s (Free) / 60s (Pro).
    // The zone is confirmed Free, so pin to the Free ceiling.
    expect(rateLimitRule?.ratelimit.mitigation_timeout).toBe(10);
  });

  it('pins the counting period to the Free plan’s only allowed value', () => {
    // Production rejected period: 60 with `not entitled to use the period 60,
    // can only use a period among [10]` — Free accepts only a 10s window. A
    // re-tune back to 60 must fail here, not with a 400 on apply.
    expect(rateLimitRule?.ratelimit.period).toBe(10);
    // 30 per 10s (~180/min) keeps headroom for the ~60/min-per-IP-per-colo
    // intent given the expression can't exclude prefetches on this plan (see
    // the expression test below), so a list-page browser's prefetch burst
    // counts too, on top of the burstier 10s window itself.
    expect(rateLimitRule?.ratelimit.requests_per_period).toBe(60);
  });

  it('keys the counter on the client IP and the required colo characteristic', () => {
    // Cloudflare rejects a non-Enterprise rate-limit rule that omits cf.colo.id.
    expect(rateLimitRule?.ratelimit.characteristics).toEqual(['ip.src', 'cf.colo.id']);
  });

  it('covers every climb-view URL shape on www, including the locale prefixes', () => {
    // A pattern per route tree would miss whichever tree is added next, so the
    // rule matches the /view/ segment that all of them share.
    const expression = rateLimitRule?.expression ?? '';
    expect(expression).toContain(`http.host eq "${WWW_HOSTNAME}"`);
    expect(expression).toContain('"/view/"');
    // Host-scoped: a future origin on ws must not inherit it.
    expect(expression).not.toContain(WS_HOSTNAME);
  });

  it('never references request headers, which the Free plan rejects', () => {
    // A prior revision added `http.request.headers.names[*] ==
    // "next-router-prefetch"` to skip Next.js prefetches, and production
    // apply rejected it: `not entitled: the use of field
    // http.request.headers.names is not allowed, an higher Advanced Rate
    // Limiting plan is required`. Guard against that regressing.
    const expression = rateLimitRule?.expression ?? '';
    expect(expression).not.toContain('http.request.headers');
  });

  it('treats a threshold change as drift', () => {
    // Without ratelimit in the comparison the rule is write-once: re-tuning
    // requests_per_period would diff clean and never reach the zone.
    const live = matchingLiveRules(desired.rateLimitRules)[0];
    expect(cacheRuleMatches(live, desired.rateLimitRules[0])).toBe(true);

    const retuned = {
      ...desired.rateLimitRules[0],
      ratelimit: { ...desired.rateLimitRules[0].ratelimit, requests_per_period: 45 },
    };
    expect(cacheRuleMatches(live, retuned)).toBe(false);
  });
});

describe('apex → www redirect (#4655)', () => {
  const redirectRule = desired.redirectRules.find((rule) => rule.description === APEX_REDIRECT_RULE_DESCRIPTION);

  it('registers the dynamic-redirect phase, so the read, diff and apply all cover it', () => {
    // The registry is the single array all three iterate. A phase declared
    // anywhere else gets planned and never written, or written and never
    // planned — the exact bug MANAGED_RULE_PHASES exists to prevent.
    const entry = MANAGED_RULE_PHASES.find((phase) => phase.resource === 'redirect-rule');
    expect(entry?.phase).toBe(DYNAMIC_REDIRECT_RULE_PHASE);
    expect(DYNAMIC_REDIRECT_RULE_PHASE).toBe('http_request_dynamic_redirect');
    expect(entry && resolveRulePhase('redirect-rule')).toBe(entry);
    expect(entry && [...entry.selectDesired(desired)]).toEqual(desired.redirectRules);
  });

  it('points the apex at Cloudflare rather than at an origin', () => {
    // Originless by design: the record exists so Cloudflare terminates the
    // request and the rule below answers it. `192.0.2.0` is one of the two
    // addresses Cloudflare documents for exactly this — RFC 5737 TEST-NET-1,
    // reserved and never routed, so a packet that escaped the proxy goes
    // nowhere real.
    expect(apexDnsRecord).toEqual({
      management: 'full',
      name: 'boardsesh.com',
      type: 'A',
      content: '192.0.2.0',
      ttl: 1,
      proxied: true,
    });
    expect(APEX_ORIGINLESS_ADDRESS).toBe('192.0.2.0');
    // Grey-clouding it would leave the apex resolving to an unroutable address
    // with nothing in front of it, i.e. the domain goes dark.
    expect(apexDnsRecord.proxied).toBe(true);
  });

  it('keeps the record TYPE the live apex already has, so the apply is in place', () => {
    // The apex is an existing DNS-only A record to Vercel. Declaring the AAAA
    // placeholder instead would make the apply change the record's type, which
    // either lands a second record beside the A — split-brain, some resolvers
    // on Vercel unproxied and some on Cloudflare — or leans on the API
    // accepting a type change in place. Neither belongs in a production apply.
    expect(apexDnsRecord.type).toBe(liveVercelApexDnsRecord().type);
  });

  it('plans the flip off Vercel as content + proxied only', () => {
    const change = diffDnsRecord(apexDnsRecord, liveVercelApexDnsRecord());

    expect(change?.dnsName).toBe(APEX_HOSTNAME);
    expect(change?.detail).toContain('content 76.76.21.21 → 192.0.2.0');
    expect(change?.detail).toContain('proxied false → true');
    // No type change: that is the whole point of the A-record placeholder.
    expect(change?.detail).not.toContain('type ');
    // No settings block on this record, so nothing to say about flattening.
    expect(change?.detail).not.toContain('flatten_cname');
  });

  it('writes the apex body without a settings block', () => {
    expect(fullyManagedDnsBody(apexDnsRecord)).toEqual({
      type: 'A',
      name: 'boardsesh.com',
      content: '192.0.2.0',
      ttl: 1,
      proxied: true,
    });
  });

  it('sends a 301 to www, rebuilding the path and preserving the query', () => {
    // Cloudflare's single-redirect shape: the payload nests under
    // action_parameters.from_value, and target_url is EITHER { value } for a
    // fixed destination or { expression } for a computed one — never both.
    expect(redirectRule).toEqual({
      description: APEX_REDIRECT_RULE_DESCRIPTION,
      expression: 'http.host eq "boardsesh.com"',
      action: 'redirect',
      action_parameters: {
        from_value: {
          status_code: 301,
          target_url: { expression: 'concat("https://www.boardsesh.com", http.request.uri.path)' },
          preserve_query_string: true,
        },
      },
      enabled: true,
    });
    // preserve_query_string is what carries `?a=1`, which is why the expression
    // only rebuilds the path. Cloudflare's rules language has no ternary
    // operator, so assembling the query inside the expression is not an option.
    expect(redirectRule?.action_parameters.from_value.target_url.expression).not.toContain('uri.query');
  });

  it('matches the apex and nothing else on the zone', () => {
    // http.host is the request Host header. Every other name on this zone —
    // www, ws, assets, app, updates — has to keep serving itself.
    const expression = redirectRule?.expression ?? '';
    for (const host of [WWW_HOSTNAME, WS_HOSTNAME, ASSETS_HOSTNAME, 'app.boardsesh.com', 'updates.boardsesh.com']) {
      expect(expression).not.toContain(`"${host}"`);
    }
    expect(expression).toContain(`"${APEX_HOSTNAME}"`);
  });

  it('keeps the marker distinct from every other managed rule', () => {
    // Identity is the description marker, across all phases: a collision would
    // make the upsert treat one rule as another and silently drop it.
    const everyDescription = MANAGED_RULE_PHASES.flatMap((phase) =>
      phase.selectDesired(desired).map((rule) => rule.description),
    );
    expect(new Set(everyDescription).size).toBe(everyDescription.length);
    expect(APEX_REDIRECT_RULE_DESCRIPTION).toContain('boardsesh:apex-to-www');
  });

  it('round-trips through the phase upsert: create, then no-op', () => {
    const created = upsertCacheRule([], [...desired.redirectRules]);
    expect(created.changed).toBe(true);
    expect(created.rules).toHaveLength(desired.redirectRules.length);
    expect(created.rules[0]).toMatchObject({
      description: APEX_REDIRECT_RULE_DESCRIPTION,
      action: 'redirect',
      action_parameters: desired.redirectRules[0].action_parameters,
    });

    const live = matchingLiveRules([...desired.redirectRules]);
    expect(cacheRuleMatches(live[0], desired.redirectRules[0])).toBe(true);
    expect(upsertCacheRule(live, [...desired.redirectRules]).changed).toBe(false);
    expect(diffManagedRules(live, desired.redirectRules, 'redirect-rule')).toEqual([]);
  });

  it('treats a changed status code as drift', () => {
    // The redirect payload lives entirely in action_parameters, so if that were
    // dropped from the comparison the rule would be write-once and a later
    // 301 → 302 edit would diff clean and never reach the zone.
    const live = matchingLiveRules([...desired.redirectRules])[0];
    const asDeclared = desired.redirectRules[0];
    const temporary = {
      ...asDeclared,
      action_parameters: {
        from_value: { ...asDeclared.action_parameters.from_value, status_code: 302 as unknown as 301 },
      },
    };
    expect(cacheRuleMatches(live, temporary)).toBe(false);
  });

  it('preserves a foreign redirect rule when it writes its own', () => {
    // The PUT replaces the WHOLE phase. Any redirect someone added by hand — a
    // vanity URL, a campaign link — is deleted unless it is merged through.
    const foreignRedirect: RulesetRule = {
      id: 'foreign-redirect-id',
      version: '1',
      description: 'hand-made vanity redirect',
      expression: '(http.request.uri.path eq "/discord")',
      action: 'redirect',
      action_parameters: { from_value: { status_code: 302, target_url: { value: 'https://discord.gg/boardsesh' } } },
      enabled: true,
    };

    const { rules } = upsertCacheRule([foreignRedirect], [...desired.redirectRules]);

    expect(rules[0]).toBe(foreignRedirect);
    expect(rules).toHaveLength(1 + desired.redirectRules.length);
    expect(rules.at(-1)?.description).toBe(APEX_REDIRECT_RULE_DESCRIPTION);
  });

  it('plans the redirect rule when the phase is empty', () => {
    const drifted: LiveState = { ...inSyncLiveState(), rules: { ...inSyncRules(), 'redirect-rule': [] } };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });

    expect(changes.map((change) => change.resource)).toEqual(['redirect-rule']);
    expect(changes[0].summary).toContain('Redirect rule');
    expect(changes[0].summary).toContain('missing — will create');
  });

  it('names the Cloudflare permission the phase needs', () => {
    // Without it, deploy-cloudflare 403s on THIS phase only: the cache, WAF and
    // rate-limit phases apply and the zone is left half-converged.
    expect(TOKEN_SCOPES.join('\n')).toContain('Zone.Dynamic Redirect Edit');
  });
});

describe('the apply loop, driven end to end against a stubbed Cloudflare API', () => {
  // Every test above this one checks a pure function. None of them can see the
  // failure that actually matters: a plan that reports drift and an apply loop
  // that never issues the write. This drives the real entry point and asserts
  // on the requests it makes.
  interface RecordedRequest {
    method: string;
    pathname: string;
    body: Record<string, unknown> | undefined;
  }

  const phaseEntrypoint = (phase: string) => `/client/v4/zones/zone-1/rulesets/phases/${phase}/entrypoint`;

  const otherApexRecord = (id: string, type: string, content: string): LiveDnsRecord => ({
    id,
    name: APEX_HOSTNAME,
    type,
    content,
    ttl: 1,
    proxied: false,
  });

  /** DNS as the zone answers today: everything converged except the apex, which is passed in. */
  function dnsResponses(apexRecord: LiveDnsRecord): Record<string, LiveDnsRecord[]> {
    return {
      [WS_HOSTNAME]: [liveDnsRecord()],
      [ASSETS_HOSTNAME]: [liveAssetsDnsRecord()],
      [WWW_HOSTNAME]: [liveWwwDnsRecord()],
      // The apex carries the mail and verification records every zone has.
      // Cloudflare returns them from the same by-name lookup, and they must not
      // make the address record look ambiguous and fail the whole run.
      [APEX_HOSTNAME]: [
        otherApexRecord('apex-txt-id', 'TXT', 'v=spf1 -all'),
        apexRecord,
        otherApexRecord('apex-mx-id', 'MX', '10 mx.example.com'),
        otherApexRecord('apex-caa-id', 'CAA', '0 issue "letsencrypt.org"'),
      ],
    };
  }

  /** Stub the API with every managed phase EMPTY, so all of them are drift. */
  function stubCloudflareApi(dnsByName: Record<string, LiveDnsRecord[]>): RecordedRequest[] {
    const requests: RecordedRequest[] = [];
    const envelope = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });

    vi.stubGlobal('fetch', (input: string, init?: { method?: string; body?: string }) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        pathname: url.pathname,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });

      if (url.pathname === '/client/v4/zones') return envelope([{ id: 'zone-1', name: desired.zoneName }]);
      if (url.pathname === '/client/v4/zones/zone-1/dns_records') {
        return envelope(dnsByName[url.searchParams.get('name') ?? ''] ?? []);
      }
      if (url.pathname.startsWith('/client/v4/zones/zone-1/dns_records/')) return envelope({});
      if (url.pathname === '/client/v4/zones/zone-1/settings/ssl') return envelope({ id: 'ssl', value: 'strict' });
      if (url.pathname === '/client/v4/zones/zone-1/dns_settings') return envelope({ flatten_all_cnames: false });
      if (url.pathname.includes('/rulesets/phases/')) return envelope({ id: 'ruleset-id', rules: [] });
      throw new Error(`Unstubbed Cloudflare request: ${method} ${url.pathname}`);
    });

    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    // Empty, so the run exercises the resolve-zone-id-by-name path too.
    vi.stubEnv('CLOUDFLARE_ZONE_ID', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return requests;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes EVERY registered rule phase, so a phase can never be planned but not applied', async () => {
    const requests = stubCloudflareApi(dnsResponses(liveApexDnsRecord()));

    expect(await runCloudflareApply(['--apply'])).toBe(0);

    const written = requests.filter((request) => request.method === 'PUT').map((request) => request.pathname);
    for (const phase of MANAGED_RULE_PHASES) {
      expect(written, `${phase.phase} was planned but never written`).toContain(phaseEntrypoint(phase.phase));
    }
    // One PUT per phase, not one per drifted rule — the rulesets API only offers
    // a whole-phase write.
    expect(written).toHaveLength(MANAGED_RULE_PHASES.length);
  });

  it('sends the apex redirect rule verbatim in the dynamic-redirect PUT', async () => {
    const requests = stubCloudflareApi(dnsResponses(liveApexDnsRecord()));

    await runCloudflareApply(['--apply']);

    const redirectPut = requests.find(
      (request) => request.method === 'PUT' && request.pathname === phaseEntrypoint(DYNAMIC_REDIRECT_RULE_PHASE),
    );
    expect(redirectPut?.body).toEqual({ rules: desired.redirectRules });
  });

  it('converges the apex off Vercel without tripping over its TXT, MX and CAA siblings', async () => {
    const requests = stubCloudflareApi(dnsResponses(liveVercelApexDnsRecord()));

    expect(await runCloudflareApply(['--apply'])).toBe(0);

    const apexPatch = requests.find(
      (request) => request.method === 'PATCH' && request.pathname.endsWith('/dns_records/apex-dns-record-id'),
    );
    // PATCH, not POST: the apex record already exists and keeps its id, so the
    // Vercel A record is updated in place rather than joined by a second one.
    expect(apexPatch?.body).toEqual({
      type: 'A',
      name: APEX_HOSTNAME,
      content: APEX_ORIGINLESS_ADDRESS,
      ttl: 1,
      proxied: true,
    });
    // www and ws are already converged, so nothing else on the zone is touched,
    // and nothing is CREATED anywhere.
    expect(requests.filter((request) => request.method === 'PATCH' || request.method === 'POST')).toHaveLength(1);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('aborts before any write when the apex holds two address records', async () => {
    // With the address-type filter in place, TXT/MX/CAA siblings are ignored —
    // but an A AND an AAAA at the apex is a real conflict. Picking one would
    // silently converge half the zone's resolvers onto a black hole, so the
    // read fails closed, and it runs before every mutation.
    const both = dnsResponses(liveVercelApexDnsRecord());
    both[APEX_HOSTNAME] = [
      ...both[APEX_HOSTNAME],
      liveApexDnsRecord({ id: 'apex-aaaa-id', type: 'AAAA', content: '100::' }),
    ];
    const requests = stubCloudflareApi(both);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runCloudflareApply(['--apply'])).rejects.toThrow('ambiguous');

    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('mutates nothing on a dry-run, and still reports the drift with a non-zero exit', async () => {
    const requests = stubCloudflareApi(dnsResponses(liveVercelApexDnsRecord()));

    expect(await runCloudflareApply([])).toBe(1);

    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
