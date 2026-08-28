import 'server-only';
import { unstable_cache } from 'next/cache';
import * as Sentry from '@sentry/nextjs';

/**
 * Server-side PostHog feature-flag evaluation.
 *
 * `FeatureFlagsProvider` resolves flags in the BROWSER (posthog-js-lite), which
 * is fine for hiding a button and useless for gating reachability: by the time
 * the browser knows the answer the server has already rendered and sent the
 * page. A surface that must 404 when its flag is off has to ask PostHog before
 * it renders, which is what this module does. It is deliberately generic — the
 * gym directory was the first caller and has since launched unconditionally,
 * so nothing gates a route on it today; every later flag-gated SSR surface
 * reuses it rather than reinventing the fail-closed path.
 *
 * Resolution order, and the reasoning behind each step:
 *
 *  1. `FEATURE_FLAG_OVERRIDES` — the only way to exercise a flag-gated surface
 *     locally. The browser PostHog client refuses to initialise off a
 *     production hostname (`isProductionHost`, app/lib/analytics.ts), so on
 *     localhost there is no person, no distinct id, and nothing to evaluate
 *     against.
 *  2. No PostHog key configured -> `false`. Preview and CI builds have no key;
 *     they get the OFF branch rather than an exception per request.
 *  3. No distinct id -> `false`. See `getServerFeatureFlag`'s note.
 *  4. A direct POST to PostHog's flags endpoint under an `AbortController`
 *     deadline. NOT the backend's `/api/posthog` reverse proxy: that exists to
 *     dodge ad blockers in the browser, and routing through it would make
 *     server rendering depend on our own backend being up.
 *  5. Anything that throws, times out, or comes back unparseable -> `false`.
 *     Fails CLOSED: a flag exists because the surface is not ready for
 *     everyone, so an unreachable PostHog must not open the gate.
 *
 * Every step resolves to a {@link ServerFeatureFlagResolution} — a value AND
 * the reason for it — because failing closed and failing silently are not the
 * same thing. "PostHog says this person is not in the flag" and "PostHog has
 * never heard of this flag key" are the same `false` to a caller and completely
 * different problems to whoever flipped the flag in the dashboard and is
 * staring at a 404. The reason is what `/api/internal/feature-flags` reports
 * and what decides whether a resolution is worth a Sentry message.
 */

/** PostHog's own default US host. Mirrors the backend's `POSTHOG_HOST` default. */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Wall-clock ceiling on the flag call. A flag evaluation sits in front of a
 * page render, so it has to be short enough that a wedged PostHog costs a
 * degraded page rather than a hung request.
 */
const FLAG_REQUEST_TIMEOUT_MS = 1_500;

/**
 * Short on purpose. Long enough that a burst of requests from one person costs
 * one PostHog call, short enough that flipping the flag in the dashboard shows
 * up within a minute instead of at the next deploy.
 */
const FLAG_CACHE_REVALIDATE_SECONDS = 60;

export const SERVER_FEATURE_FLAG_CACHE_TAG = 'server-feature-flag';

/** Env var holding the local override list. See `parseFeatureFlagOverrides`. */
export const FEATURE_FLAG_OVERRIDES_ENV = 'FEATURE_FLAG_OVERRIDES';

const TRUTHY_OVERRIDE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSY_OVERRIDE_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Parse `FEATURE_FLAG_OVERRIDES` into a key -> boolean map.
 *
 * Two forms, comma separated:
 *   `some-flag`        — bare key, forces ON
 *   `some-flag=false`  — explicit value, forces ON or OFF
 *
 * An explicit OFF matters as much as an ON: it is how you check the 404 branch
 * without editing the PostHog dashboard. Entries that parse to neither are
 * ignored rather than throwing — a typo in a dev env var should not take the
 * whole page down.
 */
export function parseFeatureFlagOverrides(raw: string | undefined): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (!raw) {
    return overrides;
  }

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      overrides[trimmed] = true;
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (TRUTHY_OVERRIDE_VALUES.has(value)) {
      overrides[key] = true;
    } else if (FALSY_OVERRIDE_VALUES.has(value)) {
      overrides[key] = false;
    }
  }

  return overrides;
}

/** Env var names holding the PostHog project key, in resolution order. */
const API_KEY_ENV_NAMES = ['POSTHOG_PROJECT_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const;

export type PosthogApiKeySource = (typeof API_KEY_ENV_NAMES)[number];

function resolvePosthogApiKey(): { key: string; source: PosthogApiKeySource } | null {
  // `POSTHOG_PROJECT_KEY` first, `NEXT_PUBLIC_POSTHOG_KEY` as the fallback —
  // the same pair, in the same order, that the backend's posthog service uses.
  for (const source of API_KEY_ENV_NAMES) {
    const key = process.env[source]?.trim();
    if (key) {
      return { key, source };
    }
  }
  return null;
}

function resolvePosthogHost(): string {
  // `POSTHOG_HOST`, not `NEXT_PUBLIC_POSTHOG_HOST`: the public one is the
  // browser's knob and is allowed to point at the ad-blocker-dodging proxy.
  const host = process.env.POSTHOG_HOST?.trim();
  return (host || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
}

/**
 * Why a flag resolved the way it did.
 *
 * The ones that mean "the gate is broken, not closed" — `flag-missing`,
 * `quota-limited`, `http-error`, `request-failed` — are each a `false` that has
 * nothing to do with the rollout the dashboard is showing. See BROKEN_REASONS.
 */
export type ServerFeatureFlagReason =
  /** `FEATURE_FLAG_OVERRIDES` decided it, ON or OFF. PostHog was not asked. */
  | 'override'
  /** No project key in the environment — preview and CI builds by design. */
  | 'no-api-key'
  /** Nobody signed in and the caller did not pass `allowAnonymous`. */
  | 'no-distinct-id'
  /** PostHog evaluated the flag and this person is in it. */
  | 'posthog-enabled'
  /** PostHog evaluated the flag and this person is NOT in it. */
  | 'posthog-disabled'
  /**
   * PostHog answered 200 without mentioning the flag at all. NOT "you're not in
   * the rollout" — PostHog returns those with `enabled: false`. It means the key
   * does not exist in the project the api key belongs to: a typo, a flag deleted
   * or renamed in the dashboard, or a key pointing at the wrong project.
   */
  | 'flag-missing'
  /** PostHog stopped serving flags for the project (billing/quota). */
  | 'quota-limited'
  /** PostHog answered non-2xx. */
  | 'http-error'
  /** The request threw, timed out, or came back unparseable. */
  | 'request-failed';

export type ServerFeatureFlagResolution = {
  enabled: boolean;
  reason: ServerFeatureFlagReason;
  /** HTTP status for `http-error`, the error name for `request-failed`. */
  detail: string | null;
};

/**
 * Reasons that mean the gate could not be evaluated, rather than that it
 * evaluated to closed. Only these are worth a Sentry message — a healthy
 * `posthog-disabled` is the entire point of a flag and must stay quiet.
 *
 * `flag-missing` and `quota-limited` are in here deliberately: both are 200 OK
 * responses that used to fall through to a bare `false`, so a key pointing at
 * the wrong PostHog project produced a 404'd page and not one line of telemetry
 * anywhere.
 */
const BROKEN_REASONS: ReadonlySet<ServerFeatureFlagReason> = new Set([
  'flag-missing',
  'quota-limited',
  'http-error',
  'request-failed',
]);

// Once per flag key per OUTAGE, not per process. A flag call that starts
// failing fails on every request, so one Sentry message says the same thing as
// ten thousand — but a key that stays latched for the life of the process turns
// a broken → recovered → broken again cycle into a silent second outage, which
// is the failure this module exists to make visible. A successful evaluation
// re-arms the key, so each distinct outage costs exactly one message.
const reportedFailures = new Set<string>();

function reportUnevaluableFlag(key: string, resolution: ServerFeatureFlagResolution): void {
  if (!BROKEN_REASONS.has(resolution.reason)) {
    // PostHog answered, so whatever was wrong is over. Re-arm.
    reportedFailures.delete(key);
    return;
  }
  if (reportedFailures.has(key)) {
    return;
  }
  reportedFailures.add(key);
  const detail = resolution.detail ? `${resolution.reason}: ${resolution.detail}` : resolution.reason;
  Sentry.captureMessage(
    `Server feature flag "${key}" could not be evaluated (${detail}); treating it as off`,
    'warning',
  );
}

/**
 * Shape of the response from PostHog's `/flags/?v=2` endpoint. `flags` is the
 * v2 shape; `featureFlags` is the older `/decide` shape PostHog still returns
 * alongside it, kept as a fallback so a version skew degrades to a working
 * answer instead of a silent `false`. `quotaLimited` names the products PostHog
 * has stopped serving for the project.
 */
type PosthogFlagsResponse = {
  flags?: Record<string, { enabled?: boolean } | undefined>;
  featureFlags?: Record<string, boolean | string | undefined>;
  quotaLimited?: string[];
};

function readFlagResolution(payload: PosthogFlagsResponse, key: string): ServerFeatureFlagResolution {
  const v2 = payload.flags?.[key];
  if (v2 && typeof v2.enabled === 'boolean') {
    return { enabled: v2.enabled, reason: v2.enabled ? 'posthog-enabled' : 'posthog-disabled', detail: null };
  }

  const legacy = payload.featureFlags?.[key];
  if (typeof legacy === 'boolean') {
    return { enabled: legacy, reason: legacy ? 'posthog-enabled' : 'posthog-disabled', detail: null };
  }
  // A string is a multivariate variant; the caller asked a boolean question,
  // and any variant means the person is in the flag.
  if (typeof legacy === 'string' && legacy.length > 0) {
    return { enabled: true, reason: 'posthog-enabled', detail: null };
  }

  // The flag is absent, which needs explaining. A quota-limited project answers
  // 200 with an EMPTY `flags` map, so that is one explanation and a deleted or
  // renamed flag is the other.
  //
  // Tested AFTER the lookup and on ANY quota limitation rather than on the
  // `feature_flags` product string: checking a hardcoded product name first
  // would call a project that is only quota-limited on, say, recordings
  // `quota-limited` while its flags resolve perfectly, and would silently
  // degrade to `flag-missing` the day PostHog renames the string — sending
  // whoever is debugging to look for a renamed flag during a billing outage,
  // which is exactly the confusion this reason vocabulary exists to prevent.
  const quotaLimited = payload.quotaLimited?.filter((product) => product.trim().length > 0) ?? [];
  if (quotaLimited.length > 0) {
    return { enabled: false, reason: 'quota-limited', detail: quotaLimited.join(', ') };
  }

  return { enabled: false, reason: 'flag-missing', detail: null };
}

/**
 * `report: false` for the diagnostic probe. The Sentry guard is once per
 * process per key, so a reporting probe would spend that budget and silence the
 * warning the next genuinely broken PAGE request in the same worker would have
 * sent — an observability endpoint quietly costing observability. The probe's
 * caller reads the reason off the return value and needs no side effect.
 */
async function evaluateFlagFromPosthog(
  key: string,
  distinctId: string,
  apiKey: string,
  { report }: { report: boolean },
): Promise<ServerFeatureFlagResolution> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAG_REQUEST_TIMEOUT_MS);

  const finish = (resolution: ServerFeatureFlagResolution): ServerFeatureFlagResolution => {
    if (report) {
      reportUnevaluableFlag(key, resolution);
    }
    return resolution;
  };

  try {
    const response = await fetch(`${resolvePosthogHost()}/flags/?v=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, distinct_id: distinctId }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return finish({ enabled: false, reason: 'http-error', detail: String(response.status) });
    }

    const payload = (await response.json()) as PosthogFlagsResponse;
    return finish(readFlagResolution(payload, key));
  } catch (error) {
    const detail = error instanceof Error ? error.name : 'unknown error';
    return finish({ enabled: false, reason: 'request-failed', detail });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The distinct id used for signed-out visitors when a caller opts in with
 * `allowAnonymous`.
 *
 * ONE constant shared by every anonymous request, deliberately, and the
 * trade-off is worth stating: a percentage rollout buckets on the distinct id,
 * so every signed-out visitor lands in the same bucket and a partial rollout is
 * all-or-nothing for the public. For an INDEXABLE surface that is the desired
 * behaviour — a 50% rollout that 404s half of Googlebot's crawls would put
 * soft-404s in the index, which is far worse than shipping to nobody or
 * everybody. It also means one cache entry serves the whole anonymous
 * population instead of one per visitor.
 *
 * A caller that genuinely needs per-visitor bucketing of anonymous traffic
 * should pass its own stable id rather than loosening this.
 */
export const ANONYMOUS_DISTINCT_ID = 'anonymous-web-visitor';

export type ServerFeatureFlagOptions = {
  /**
   * The identifier PostHog knows the person by — `session.user.id`, the same
   * value `identify()` is called with. This is the failure mode worth spelling
   * out: a flag targeted at a PERSON PROPERTY (an email, a cohort) only matches
   * when the evaluation names a person PostHog holds those properties for. Send
   * a freshly-generated id and PostHog answers `false` for a perfectly
   * configured flag, with nothing erroring anywhere and the dashboard showing
   * the flag active.
   */
  distinctId: string | null;
  /**
   * Evaluate for signed-out visitors too, using {@link ANONYMOUS_DISTINCT_ID}.
   *
   * Default `false`, which short-circuits a null `distinctId` to `false`
   * without a network call. That default is right for a flag gating a
   * signed-in-only control targeted at a person property: no person, no match,
   * and the round trip is wasted.
   *
   * It is WRONG for anything that must eventually be public. A flag's condition
   * changes shape over its life — it starts as "this one person's email" and
   * ends as "100% of everyone" — and a percentage rollout needs *a* distinct
   * id, not a *known* one. Without this opt-in the surface stays signed-in-only
   * however the dashboard is configured, and flipping the rollout to 100%
   * changes nothing for anonymous visitors or crawlers.
   */
  allowAnonymous?: boolean;
};

/** The steps that resolve without asking PostHog, shared by cached and probe. */
function resolveWithoutPosthog(
  key: string,
  options: ServerFeatureFlagOptions,
): { resolution: ServerFeatureFlagResolution } | { apiKey: string; distinctId: string } {
  const override = parseFeatureFlagOverrides(process.env[FEATURE_FLAG_OVERRIDES_ENV])[key];
  if (override !== undefined) {
    return { resolution: { enabled: override, reason: 'override', detail: null } };
  }

  const apiKey = resolvePosthogApiKey();
  if (!apiKey) {
    return { resolution: { enabled: false, reason: 'no-api-key', detail: null } };
  }

  const distinctId = options.distinctId ?? (options.allowAnonymous ? ANONYMOUS_DISTINCT_ID : null);
  if (!distinctId) {
    return { resolution: { enabled: false, reason: 'no-distinct-id', detail: null } };
  }

  return { apiKey: apiKey.key, distinctId };
}

/**
 * Resolve one feature flag on the server, with the reason behind the answer.
 *
 * This is what a page gate should call when it wants to log or expose WHY it
 * closed; {@link getServerFeatureFlag} is the boolean-only wrapper.
 */
export async function getServerFeatureFlagResolution(
  key: string,
  options: ServerFeatureFlagOptions,
): Promise<ServerFeatureFlagResolution> {
  const early = resolveWithoutPosthog(key, options);
  if ('resolution' in early) {
    return early.resolution;
  }
  const { apiKey, distinctId } = early;

  // Keyed on the flag AND the person: two climbers must never share an answer.
  // If this key ever loses `distinctId`, one person's flag value is served to
  // everyone — the highest-severity failure this module has, and the reason
  // there is a test asserting the key parts rather than only the return value.
  const cached = unstable_cache(
    () => evaluateFlagFromPosthog(key, distinctId, apiKey, { report: true }),
    ['posthog-flag', key, distinctId],
    {
      revalidate: FLAG_CACHE_REVALIDATE_SECONDS,
      tags: [SERVER_FEATURE_FLAG_CACHE_TAG],
    },
  );

  return cached();
}

/** Resolve one feature flag on the server. */
export async function getServerFeatureFlag(key: string, options: ServerFeatureFlagOptions): Promise<boolean> {
  const { enabled } = await getServerFeatureFlagResolution(key, options);
  return enabled;
}

/**
 * The same resolution, skipping the data cache.
 *
 * For diagnostics ONLY. A gate that is 404ing because a stale `false` is still
 * inside its 60s window looks identical to one that is 404ing because PostHog
 * says no, and the difference decides whether you wait a minute or go fix the
 * dashboard — so `/api/internal/feature-flags` reports the cached answer and
 * this one side by side. Never call it from a page: it is an uncached network
 * round trip in front of a render.
 *
 * Deliberately does not report to Sentry — see `evaluateFlagFromPosthog`.
 */
export async function probeServerFeatureFlag(
  key: string,
  options: ServerFeatureFlagOptions,
): Promise<ServerFeatureFlagResolution> {
  const early = resolveWithoutPosthog(key, options);
  if ('resolution' in early) {
    return early.resolution;
  }
  return evaluateFlagFromPosthog(key, early.distinctId, early.apiKey, { report: false });
}

export type ServerFeatureFlagConfig = {
  /** Which env var supplied the project key, or null when none is set. */
  apiKeySource: PosthogApiKeySource | null;
  /** The PostHog host being asked. Not a secret; a wrong one is a real cause. */
  host: string;
  /** Parsed `FEATURE_FLAG_OVERRIDES`, which silently outranks the dashboard. */
  overrides: Record<string, boolean>;
};

/**
 * The environment this module is resolving flags against — never the key
 * itself, only which variable it came from.
 */
export function describeServerFeatureFlagConfig(): ServerFeatureFlagConfig {
  return {
    apiKeySource: resolvePosthogApiKey()?.source ?? null,
    host: resolvePosthogHost(),
    overrides: parseFeatureFlagOverrides(process.env[FEATURE_FLAG_OVERRIDES_ENV]),
  };
}
