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
 * whether a route renders at all (`gyms-directory` today).
 *
 * It exists because "the dashboard says 100% and the page still 404s" has half a
 * dozen causes that look identical from outside: no project key in the runtime
 * env, a key pointing at another PostHog project, the flag renamed or deleted,
 * the project quota-limited, PostHog timing out, `FEATURE_FLAG_OVERRIDES` set to
 * OFF somewhere, or a stale `false` still inside the 60s data-cache window. All
 * of those fail closed, by design — and used to fail closed identically, with no
 * way to tell them apart short of a Sentry message that four of them never sent.
 *
 * Reported per flag:
 *   `page`   — the cached resolution, exactly what a gated route sees right now
 *   `public` — an uncached probe as a signed-out visitor (what a crawler gets)
 *   `viewer` — an uncached probe as the calling admin, when signed in
 *
 * `page` disagreeing with `public` means the answer is cached and will catch up;
 * `public.reason` explains everything else. No secret is returned: the config
 * block names which env var held the key, never its value.
 */
export const dynamic = 'force-dynamic';

/** Guards the free-text `?key=`, which is forwarded to PostHog verbatim. */
const FLAG_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type FeatureFlagDiagnostic = {
  key: string;
  page: ServerFeatureFlagResolution;
  public: ServerFeatureFlagResolution;
  viewer: ServerFeatureFlagResolution | null;
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

  const keys: string[] = requestedKey ? [requestedKey] : [...SERVER_FEATURE_FLAG_KEYS];
  const viewerDistinctId = await getPosthogDistinctId();

  const flags = await Promise.all(
    keys.map(async (key): Promise<FeatureFlagDiagnostic> => {
      const [page, publicResolution, viewer] = await Promise.all([
        // Same arguments the gated routes pass, so this is their answer and not
        // a re-derivation of it.
        getServerFeatureFlagResolution(key, { distinctId: viewerDistinctId, allowAnonymous: true }),
        probeServerFeatureFlag(key, { distinctId: null, allowAnonymous: true }),
        viewerDistinctId ? probeServerFeatureFlag(key, { distinctId: viewerDistinctId }) : Promise.resolve(null),
      ]);
      return { key, page, public: publicResolution, viewer };
    }),
  );

  const response: FeatureFlagDiagnosticsResponse = {
    config: { ...describeServerFeatureFlagConfig(), anonymousDistinctId: ANONYMOUS_DISTINCT_ID },
    viewerDistinctId,
    flags,
  };

  return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
}
