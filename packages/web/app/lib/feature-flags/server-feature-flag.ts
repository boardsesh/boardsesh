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
 * gym directory is the first caller, every later flag-gated SSR surface reuses
 * it.
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
 *   `gyms-directory`        — bare key, forces ON
 *   `gyms-directory=false`  — explicit value, forces ON or OFF
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

function resolvePosthogApiKey(): string | null {
  // `POSTHOG_PROJECT_KEY` first, `NEXT_PUBLIC_POSTHOG_KEY` as the fallback —
  // the same pair, in the same order, that the backend's posthog service uses.
  const key = process.env.POSTHOG_PROJECT_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  return key ? key : null;
}

function resolvePosthogHost(): string {
  // `POSTHOG_HOST`, not `NEXT_PUBLIC_POSTHOG_HOST`: the public one is the
  // browser's knob and is allowed to point at the ad-blocker-dodging proxy.
  const host = process.env.POSTHOG_HOST?.trim();
  return (host || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
}

// Once per process, per flag key. A flag call that starts failing fails on
// every request; one Sentry message says the same thing as ten thousand.
const reportedFailures = new Set<string>();

function reportFlagFailure(key: string, detail: string): void {
  if (reportedFailures.has(key)) {
    return;
  }
  reportedFailures.add(key);
  Sentry.captureMessage(
    `Server feature flag "${key}" could not be evaluated (${detail}); treating it as off`,
    'warning',
  );
}

/**
 * Shape of the response from PostHog's `/flags/?v=2` endpoint. `flags` is the
 * v2 shape; `featureFlags` is the older `/decide` shape PostHog still returns
 * alongside it, kept as a fallback so a version skew degrades to a working
 * answer instead of a silent `false`.
 */
type PosthogFlagsResponse = {
  flags?: Record<string, { enabled?: boolean } | undefined>;
  featureFlags?: Record<string, boolean | string | undefined>;
};

function readFlagValue(payload: PosthogFlagsResponse, key: string): boolean {
  const v2 = payload.flags?.[key];
  if (v2 && typeof v2.enabled === 'boolean') {
    return v2.enabled;
  }
  const legacy = payload.featureFlags?.[key];
  if (typeof legacy === 'boolean') {
    return legacy;
  }
  // A string is a multivariate variant; the caller asked a boolean question,
  // and any variant means the person is in the flag.
  return typeof legacy === 'string' && legacy.length > 0;
}

async function evaluateFlagFromPosthog(key: string, distinctId: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAG_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${resolvePosthogHost()}/flags/?v=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, distinct_id: distinctId }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      reportFlagFailure(key, `HTTP ${response.status}`);
      return false;
    }

    const payload = (await response.json()) as PosthogFlagsResponse;
    return readFlagValue(payload, key);
  } catch (error) {
    reportFlagFailure(key, error instanceof Error ? error.name : 'unknown error');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one feature flag on the server.
 *
 * `distinctId` MUST be the same identifier PostHog knows the person by —
 * `session.user.id`, which is what `reconcileAnalyticsIdentity` passes to
 * `identify()`. This is the failure mode worth spelling out: a flag targeted at
 * a PERSON PROPERTY (an email, a cohort) only matches when the evaluation call
 * names a person PostHog has those properties for. Send an anonymous or
 * freshly-generated id and PostHog answers `false` for a perfectly configured
 * flag, with nothing erroring anywhere and the dashboard showing the flag
 * active. Signed-out visitors therefore have no person to match and correctly
 * resolve to `false` without a network call at all.
 */
export async function getServerFeatureFlag(key: string, distinctId: string | null): Promise<boolean> {
  const override = parseFeatureFlagOverrides(process.env[FEATURE_FLAG_OVERRIDES_ENV])[key];
  if (override !== undefined) {
    return override;
  }

  const apiKey = resolvePosthogApiKey();
  if (!apiKey) {
    return false;
  }

  if (!distinctId) {
    return false;
  }

  // Keyed on the flag AND the person: two climbers must never share an answer.
  const cached = unstable_cache(
    () => evaluateFlagFromPosthog(key, distinctId, apiKey),
    ['posthog-flag', key, distinctId],
    {
      revalidate: FLAG_CACHE_REVALIDATE_SECONDS,
      tags: [SERVER_FEATURE_FLAG_CACHE_TAG],
    },
  );

  return cached();
}
