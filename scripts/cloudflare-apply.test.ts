/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BOARD_RENDER_CACHE_RULE_DESCRIPTION,
  CACHE_RULE_DESCRIPTION,
  CRAWLER_ALLOW_RULE_DESCRIPTION,
  CRAWLER_ALLOW_TOKENS,
  CRAWLER_BLOCK_RULE_DESCRIPTION,
  CRAWLER_BLOCK_TOKENS,
  WWW_HOSTNAME,
  desiredCloudflareState,
} from '../infra/cloudflare/config';
import {
  buildPlan,
  cacheRuleMatches,
  diffCacheRule,
  diffManagedRules,
  diffDnsRecord,
  diffSslMode,
  jsonEqual,
  upsertCacheRule,
} from '../infra/cloudflare/plan';
import type { LiveDnsRecord, LiveState, RulesetRule } from '../infra/cloudflare/plan';
import { RELATED_TOKENS, TOKEN_SCOPES, parseArgs } from './cloudflare-apply';

const desired = desiredCloudflareState;
/** The og cache rule — the one the pre-existing cases in this file were written against. */
const ogCacheRule = desired.cacheRules[0];

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
  desiredRules: readonly { description: string; expression: string; action: string; action_parameters?: unknown }[],
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
    enabled: true,
  }));
}

function inSyncLiveState(): LiveState {
  return {
    dnsRecord: liveDnsRecord(),
    cacheRules: matchingLiveRules(desired.cacheRules),
    wafRules: matchingLiveRules(desired.wafRules),
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
      dnsRecord: liveDnsRecord({ proxied: false }),
      cacheRules: [foreignRule('foreign-a')],
      wafRules: matchingLiveRules(desired.wafRules),
      sslMode: 'full',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    // Cutover-safe order: the proxied flip is planned last, after SSL + the rules.
    // Both cache rules are missing (the phase holds only a foreign rule), and the
    // WAF phase is already in sync, so it contributes nothing.
    expect(changes.map((change) => change.resource)).toEqual(['ssl', 'cache-rule', 'cache-rule', 'dns']);
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
      wafRules: [],
      sslMode: 'strict',
    };
    const changes = buildPlan(desired, drifted, { allowZoneSsl: false });
    const dnsChange = changes.find((change) => change.resource === 'dns');
    expect(dnsChange?.blocked).toBeUndefined();
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

  it('keeps the two cache rules separately addressable', () => {
    // Identity is the description marker; a duplicate would make the upsert treat
    // one rule as the other and silently drop it.
    expect(new Set(desired.cacheRules.map((rule) => rule.description)).size).toBe(desired.cacheRules.length);
    expect(CACHE_RULE_DESCRIPTION).not.toBe(BOARD_RENDER_CACHE_RULE_DESCRIPTION);
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
});

describe('token scope guidance', () => {
  // printTokenScopes() is the only place a maintainer sees this list, so it has
  // to keep pace with the requests the tool makes — and has to steer a Pages
  // failure toward the right secret instead of toward re-scoping this one.
  it('names every zone permission the tool calls', () => {
    // One entry per request, reads included: a token missing a read scope fails
    // just as hard as one missing a write. Zone.WAF Edit went missing from this
    // list once while the crawler rules depended on it, so a partially-converged
    // zone was the failure mode rather than a clean error.
    const printed = TOKEN_SCOPES.join('\n');
    expect(printed).toContain('Zone.Zone Read'); // GET /zones?name= (resolve the zone id)
    expect(printed).toContain('Zone.DNS Edit'); // PATCH the ws record's proxied flag
    expect(printed).toContain('Zone.Cache Rules Edit'); // PUT the cache-settings phase
    expect(printed).toContain('Zone.WAF Edit'); // PUT the firewall-custom phase
    expect(printed).toContain('Zone.Zone Settings Read'); // GET /settings/ssl
    expect(printed).toContain('Zone.Zone Settings Edit'); // PATCH /settings/ssl
  });

  it('claims no account-level scope for the zone token', () => {
    // The inverse guard, and the one that matches the incident: answering a Pages
    // 10000 by adding an account policy to THIS token is what dropped the zone
    // grants on 2026-08-25. Account permissions live in a different resource
    // namespace and cannot ride along here, so nothing account-level belongs in
    // this list — Pages is deploy-app-web's PAGES_TOKEN.
    for (const scope of TOKEN_SCOPES) expect(scope).toMatch(/^Zone\./);
  });

  it('points a Pages failure at the separate secret by name', () => {
    // Without the secret's name the printout sends a maintainer back to the same
    // wrong token, since the symptom (Authentication error [code: 10000] while
    // `wrangler whoami` succeeds) reads as a bad credential, not a missing scope.
    const printed = RELATED_TOKENS.join('\n');
    expect(printed).toContain('PAGES_TOKEN');
    expect(printed).toContain('Cloudflare Pages Edit');
  });

  it('holds scopes, not prose, so the printed columns stay aligned', () => {
    // Guards shape rather than wording: an explanation parked in either array
    // prints ragged against the indent, and a blank spacer entry prints as
    // trailing whitespace. Reasons belong in comments above the list.
    for (const entry of [...TOKEN_SCOPES, ...RELATED_TOKENS]) {
      expect(entry).toMatch(/^(Zone\.|Account\.|[A-Z_]+ )\S/);
      expect(entry).toContain('—');
    }
  });
});
