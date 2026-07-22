/// <reference types="node" />

// Declarative desired-state for the Cloudflare-managed boardsesh.com zone. This
// is plain typed data — no side effects, no API calls. scripts/cloudflare-apply.ts
// reads it, diffs it against the live zone, and (only with --apply) converges the
// delta.
//
// Why this exists: we front ws.boardsesh.com (a single-region Railway origin) with
// the Cloudflare proxy so the immutable /og/* share-card images edge-cache globally.
// Everything else on that host (/graphql, REST, WebSocket upgrades) must bypass the
// cache. The manual runbook this replaces lives in docs/og-climb.md.

/** The Cloudflare zone this config manages. Resolved to a zone id by name when CLOUDFLARE_ZONE_ID is unset. */
export const ZONE_NAME = 'boardsesh.com';

/** The Railway-backed host we put behind the Cloudflare proxy. */
export const WS_HOSTNAME = 'ws.boardsesh.com';

/** Path prefix whose responses are immutable (`Cache-Control: … immutable`, 1y) and safe to edge-cache. */
export const OG_PATH_PREFIX = '/og/';

/**
 * Stable marker identifying the one cache rule this tool owns. The apply script
 * finds our rule by this exact description and upserts only it, leaving every other
 * rule in the cache phase untouched. Never change it without a migration — a new
 * value orphans the old rule (the tool would create a second rule and leave the
 * first behind).
 */
export const CACHE_RULE_DESCRIPTION = 'boardsesh:og-edge-cache (managed by scripts/cloudflare-apply.ts)';

/** The rulesets phase that holds cache-eligibility rules. */
export const CACHE_RULE_PHASE = 'http_request_cache_settings';

/** Cloudflare SSL/TLS modes ordered weakest → strongest, for the "is the live mode weaker?" check. */
export const SSL_MODE_STRENGTH = ['off', 'flexible', 'full', 'strict'] as const;
export type SslMode = (typeof SSL_MODE_STRENGTH)[number];

/** SSL/TLS mode we require for the zone. `strict` = Full (strict); Flexible causes redirect loops with Railway. */
export const REQUIRED_SSL_MODE: SslMode = 'strict';

export interface DnsRecordDesired {
  /** DNS record name (host). We assert only the proxied flag on the existing record; content/type are not managed. */
  name: string;
  /** Orange-cloud the record so requests transit the Cloudflare edge. */
  proxied: boolean;
}

export interface CacheRuleActionParameters {
  /** true = eligible for cache. */
  cache: boolean;
  edge_ttl: {
    /**
     * bypass_by_default = honour Cache-Control when present (og 200s are
     * immutable, 1y) and BYPASS when absent — error responses (400/429/503)
     * send no Cache-Control and must never be edge-cached.
     */
    mode: 'bypass_by_default';
  };
}

export interface CacheRuleDesired {
  description: string;
  expression: string;
  action: 'set_cache_settings';
  action_parameters: CacheRuleActionParameters;
  enabled: boolean;
}

export interface SslDesired {
  mode: SslMode;
}

export interface CloudflareDesiredState {
  zoneName: string;
  dns: DnsRecordDesired;
  cacheRule: CacheRuleDesired;
  ssl: SslDesired;
}

/** The Cloudflare Rules-language expression matching og share-card requests on the ws host. */
export const OG_CACHE_EXPRESSION = `(http.host eq "${WS_HOSTNAME}" and starts_with(http.request.uri.path, "${OG_PATH_PREFIX}"))`;

export const desiredCloudflareState: CloudflareDesiredState = {
  zoneName: ZONE_NAME,
  dns: {
    name: WS_HOSTNAME,
    proxied: true,
  },
  cacheRule: {
    description: CACHE_RULE_DESCRIPTION,
    expression: OG_CACHE_EXPRESSION,
    action: 'set_cache_settings',
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'bypass_by_default' },
      // Pin browser TTL to the origin header so a zone-level Browser Cache TTL
      // can't override the 1y immutable max-age.
      browser_ttl: { mode: 'respect_origin' },
    },
    enabled: true,
  },
  ssl: {
    mode: REQUIRED_SSL_MODE,
  },
};
