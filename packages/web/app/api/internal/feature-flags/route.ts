import { NextResponse } from 'next/server';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { SERVER_FEATURE_FLAG_KEYS } from '@/app/flags';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import {
  ANONYMOUS_DISTINCT_ID,
  describeServerFeatureFlagConfig,
  getServerFeatureFlagResolution,
  probeServerFeatureFlag,
  type ServerFeatureFlagConfig,
  type ServerFeatureFlagResolution,
} from '@/app/lib/feature-flags/server-feature-flag';

/**
 * Admin-only diagnostics for the SERVER-side feature flags — the ones that gate
 * whether a route renders at all. Every key in `SERVER_FEATURE_FLAG_KEYS` is
 * reported automatically; anything else is asked for ad hoc through `?key=`.
 *
 * It exists because "the dashboard says 100% and the page still 404s" has half a
 * dozen causes that look identical from outside: no project key in the runtime
 * env, a key pointing at another PostHog project, the flag renamed or deleted,
 * the project quota-limited, PostHog timing out, `FEATURE_FLAG_OVERRIDES` set to
 * OFF somewhere, or a stale `false` still inside the 60s data-cache window. All
 * of those fail closed, by design — and used to fail closed identically, with no
 * way to tell them apart short of a Sentry message that four of them never sent.
 *
 * Reported per flag, as a 2x2 — cached vs live, signed-out visitor vs the
 * calling admin:
 *   `cached.public` — the entry an anonymous request to the gated route used
 *   `cached.viewer` — the entry the admin's own request to that route used
 *   `live.public`   — an uncached probe as a signed-out visitor (crawler's view)
 *   `live.viewer`   — an uncached probe as the calling admin
 *
 * Both halves of each pair matter because the data cache is keyed per flag AND
 * per person: the admin's cached answer says nothing about the entry that 404'd
 * a visitor. Split this way each comparison means exactly one thing —
 * `cached.public` vs `live.public` is cache staleness, `live.public` vs
 * `live.viewer` is a rollout still targeted at people rather than a percentage.
 * Collapsing them into one "what the page sees" row makes those two
 * indistinguishable, which is the confusion this endpoint exists to remove.
 *
 * No secret is returned: the config block names which env var held the project
 * key, never its value.
 */
export const dynamic = 'force-dynamic';

/**
 * Guards the free-text `?key=`, which is forwarded to PostHog verbatim.
 *
 * Deliberately a shape check rather than a `SERVER_FEATURE_FLAG_KEYS`
 * membership check: an unregistered key is a legitimate question here — the
 * only kind there is while the registry is empty — because
 * `flag-missing` is precisely the answer to "did the dashboard rename it?" or
 * "does this project know that key at all?", and a membership check could only
 * ever answer keys we already know are fine.
 *
 * Dots are allowed because PostHog accepts dot-separated keys; `/` is not, so a
 * traversal-shaped string is still rejected. The key never reaches a URL or a
 * path — it is a JSON lookup and a cache-key part — so the shape check is about
 * keeping the input recognisably a flag key, not about escaping.
 */
const FLAG_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** One resolution per (cached | live) x (public | viewer). */
export type FeatureFlagAudience = {
  public: ServerFeatureFlagResolution;
  /** Null when nobody is signed in — never probed as if a person existed. */
  viewer: ServerFeatureFlagResolution | null;
};

export type FeatureFlagDiagnostic = {
  key: string;
  /** Registered in `SERVER_FEATURE_FLAG_KEYS`, vs asked for ad hoc via `?key=`. */
  registered: boolean;
  cached: FeatureFlagAudience;
  live: FeatureFlagAudience;
};

export type FeatureFlagDiagnosticsResponse = {
  config: ServerFeatureFlagConfig & { anonymousDistinctId: string };
  viewerDistinctId: string | null;
  flags: FeatureFlagDiagnostic[];
};

export async function GET(request: Request) {
  const access = await checkAdmin();
  if (!access.authenticated) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (!access.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const requestedKey = new URL(request.url).searchParams.get('key');
  if (requestedKey !== null && !FLAG_KEY_PATTERN.test(requestedKey)) {
    return NextResponse.json({ error: 'Invalid flag key' }, { status: 400 });
  }

  const registeredKeys: string[] = [...SERVER_FEATURE_FLAG_KEYS];
  const keys = requestedKey ? [requestedKey] : registeredKeys;
  const viewerDistinctId = await getPosthogDistinctId();

  const flags = await Promise.all(
    keys.map(async (key): Promise<FeatureFlagDiagnostic> => {
      const [cachedPublic, cachedViewer, livePublic, liveViewer] = await Promise.all([
        // The arguments an ANONYMOUS request to a gated route passes, so this
        // reads the very cache entry that served the visitor their 404 — not a
        // re-derivation of it, and not the admin's separate entry.
        getServerFeatureFlagResolution(key, { distinctId: null, allowAnonymous: true }),
        viewerDistinctId
          ? getServerFeatureFlagResolution(key, { distinctId: viewerDistinctId, allowAnonymous: true })
          : Promise.resolve(null),
        probeServerFeatureFlag(key, { distinctId: null, allowAnonymous: true }),
        viewerDistinctId
          ? probeServerFeatureFlag(key, { distinctId: viewerDistinctId, allowAnonymous: true })
          : Promise.resolve(null),
      ]);
      return {
        key,
        registered: registeredKeys.includes(key),
        cached: { public: cachedPublic, viewer: cachedViewer },
        live: { public: livePublic, viewer: liveViewer },
      };
    }),
  );

  const response: FeatureFlagDiagnosticsResponse = {
    config: { ...describeServerFeatureFlagConfig(), anonymousDistinctId: ANONYMOUS_DISTINCT_ID },
    viewerDistinctId,
    flags,
  };

  return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
}
