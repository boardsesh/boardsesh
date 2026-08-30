/**
 * The standing inventory oracle for issue #1889 (REST surface audit: 38
 * routes classified after the board renderer moved to Railway in #4715).
 *
 * A classification table living only in an issue body or a doc goes stale the
 * moment a route is added or removed without anyone re-reading it — exactly
 * what happened to `docs/web-reposition.md`'s mobile-consumer list and its
 * `join`/`controllers`/`favorites` row before this PR. This test makes the
 * audit executable: it walks `packages/web/app/api/**` off disk and asserts
 * SET EQUALITY, in both directions, against the pinned verdict map below.
 *
 *  - A new route file that isn't added to the map reds the "derived has an
 *    entry the map doesn't" direction — a route can't ship unclassified.
 *  - A route deleted from disk without updating the map reds the "map has an
 *    entry disk doesn't" direction — this is the one a subset-only check
 *    (`expect(derived).toContain(...)`) would silently survive, which is why
 *    both directions are asserted.
 *  - A Vercel cron target labelled as if in-repo code called it reds a third
 *    check, which reads the schedules out of vercel.json rather than trusting
 *    the comment next to the row. Set equality alone never looks at verdicts.
 *
 * This file reads the API tree with readdirSync at run time, so nothing
 * relates it to a route-file diff in test-default's `--changed` run. It is
 * run unfiltered by the `rest-surface` job in .github/workflows/ci.yml —
 * without that job the guarantees above only hold post-merge on main.
 *
 * `keep-external` = published surface with no in-repo runtime caller by
 * design (an ESP32 firmware target, a documented `/api/v1/*` route, a Vercel
 * cron target, or a crawler-only redirect shim) — "no caller" is the intended
 * steady state here, not evidence of deadness. `keep-caller` = has a live
 * in-repo (web, mobile, or backend) caller. Neither verdict means "safe to
 * delete" — see issue #1889 for the full reasoning per route.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_ROOT = join(WEB_ROOT, 'app', 'api');

type Verdict = 'keep-external' | 'keep-caller';

const VERDICTS: Record<string, Verdict> = {
  // --- /api/auth/* (8) — session/OAuth/registration, called by www and by
  // the mobile app's web auth path (and, for resend-verification, the native
  // store fleet too via the plain app/auth/register.tsx). ---
  'app/api/auth/[...nextauth]/route.ts': 'keep-caller',
  'app/api/auth/providers-config/route.ts': 'keep-caller',
  'app/api/auth/register/route.ts': 'keep-caller',
  'app/api/auth/forgot-password/route.ts': 'keep-caller',
  'app/api/auth/reset-password/route.ts': 'keep-caller',
  'app/api/auth/resend-verification/route.ts': 'keep-caller',
  'app/api/auth/verify-email/route.ts': 'keep-caller',
  'app/api/auth/native/callback/route.ts': 'keep-caller',

  // --- /api/internal/* (15) ---
  // Party-session / kiosk auth bridge — never delete.
  'app/api/internal/ws-auth/route.ts': 'keep-external',
  // No web consumer, but no production surface either (404s outside
  // NODE_ENV=development) — the only machine-readable way to confirm which
  // QA notes a running dev server started with.
  'app/api/internal/dev-metadata/route.ts': 'keep-external',
  // Vercel cron targets. Their only trigger is Vercel's scheduler reading
  // packages/web/vercel.json — no in-repo code ever calls them, which is the
  // intended steady state, not evidence of deadness. Pinned against that file
  // by `classifies every Vercel cron target as an external surface` below.
  'app/api/internal/cleanup/route.ts': 'keep-external',
  'app/api/internal/prewarm-heatmap/[board_name]/route.ts': 'keep-external',
  'app/api/internal/profile-percentiles/route.ts': 'keep-external',
  // Retained for a manual initial refresh when Railway takes over scheduling.
  // It must remain absent from Vercel's scheduler while climb sitemaps are paused.
  'app/api/internal/refresh-sitemap-climbs/route.ts': 'keep-external',
  'app/api/internal/beta-link-thumbnail/route.ts': 'keep-caller',
  'app/api/internal/revalidate-climb/route.ts': 'keep-caller',
  'app/api/internal/climb-search-cache/revalidate/route.ts': 'keep-caller',
  'app/api/internal/controllers/route.ts': 'keep-caller',
  'app/api/internal/set-password/route.ts': 'keep-caller',
  'app/api/internal/join/[sessionId]/route.ts': 'keep-caller',
  // GET is live for /settings. The PUT operation on this same file has zero
  // callers and is tracked for method-level deprecation in a follow-up issue
  // — that doesn't change this file's verdict, since GET keeps it alive.
  'app/api/internal/profile/route.ts': 'keep-caller',
  'app/api/internal/profile/[userId]/route.ts': 'keep-caller',
  'app/api/internal/feature-flags/route.ts': 'keep-caller',

  // --- /api/og/* (5) ---
  // Legacy og:image redirect shim (307 -> the Railway renderer) kept
  // for every already-shared HTML page and crawler cache from before the
  // OG-card migration to the backend (see docs/og-climb.md). New metadata
  // never emits it — no in-repo caller by design.
  'app/api/og/climb/route.tsx': 'keep-external',
  'app/api/og/playlist/route.tsx': 'keep-caller',
  'app/api/og/profile/route.tsx': 'keep-caller',
  'app/api/og/session/route.tsx': 'keep-caller',
  'app/api/og/setter/route.tsx': 'keep-caller',

  // --- /api/v1/* (10) — published in the OpenAPI doc rendered at the
  // indexable, sitemapped /docs and served as a crawlable /openapi.json.
  // "No in-repo caller" is the intended steady state of a published API. ---
  'app/api/v1/[board_name]/grades/route.ts': 'keep-external',
  'app/api/v1/grades/[board_name]/route.ts': 'keep-external',
  'app/api/v1/angles/[board_name]/[layout_id]/route.ts': 'keep-external',
  'app/api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/[climb_uuid]/route.ts': 'keep-external',
  'app/api/v1/[board_name]/climb-stats/[climb_uuid]/route.ts': 'keep-external',
  'app/api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/setters/route.ts': 'keep-external',
  'app/api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/heatmap/route.ts': 'keep-external',
  'app/api/v1/[board_name]/slugs/layout/[slug]/route.ts': 'keep-external',
  'app/api/v1/[board_name]/slugs/size/[layout_id]/[slug]/route.ts': 'keep-external',
  'app/api/v1/[board_name]/slugs/sets/[layout_id]/[size_id]/[slug]/route.ts': 'keep-external',
};

function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(entryPath, out);
    } else if (entry.isFile() && /^route\.tsx?$/.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

function toWebRelative(absolutePath: string): string {
  return join('app', 'api', absolutePath.slice(API_ROOT.length + 1))
    .split('\\')
    .join('/');
}

type VercelConfig = { crons?: { path: string }[] };

function readCronPaths(): string[] {
  const config = JSON.parse(readFileSync(join(WEB_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;
  return (config.crons ?? []).map((cron) => cron.path);
}

/**
 * Resolve a scheduled URL (`/api/internal/prewarm-heatmap/kilter`) to the route
 * key that serves it (`app/api/internal/prewarm-heatmap/[board_name]/route.ts`),
 * treating a `[param]` segment as a wildcard. Returns undefined when no route
 * file can serve the schedule at all.
 */
function routeKeyForCronPath(cronPath: string, routeKeys: string[]): string | undefined {
  const urlSegments = cronPath.replace(/^\//, '').split('/');
  return routeKeys.find((routeKey) => {
    const routeSegments = routeKey
      .replace(/^app\//, '')
      .replace(/\/route\.tsx?$/, '')
      .split('/');
    if (routeSegments.length !== urlSegments.length) return false;
    return routeSegments.every((segment, index) => segment.startsWith('[') || segment === urlSegments[index]);
  });
}

describe('REST surface inventory (issue #1889)', () => {
  const derived = new Set(collectRouteFiles(API_ROOT).map(toWebRelative));
  const pinned = new Map(Object.entries(VERDICTS));

  it('classifies every route file on disk', () => {
    const unclassified = [...derived].filter((path) => !pinned.has(path));
    expect(unclassified).toEqual([]);
  });

  it('never classifies a route file that no longer exists', () => {
    const missing = [...pinned.keys()].filter((path) => !derived.has(path));
    expect(missing).toEqual([]);
  });

  it('pins the never-delete WebSocket auth surface', () => {
    expect(pinned.get('app/api/internal/ws-auth/route.ts')).toBe('keep-external');
  });

  it('classifies every Vercel cron target as an external surface', () => {
    // Nothing else reconciles the verdict COLUMN against reality — the two
    // set-equality checks above only look at keys, so a cron route silently
    // relabelled `keep-caller` (which is how all four shipped in #4663) would
    // read as "something in the repo calls this" and invite a future audit to
    // delete it when the grep comes back empty. The expected list is derived
    // from vercel.json, so adding a schedule for a route that doesn't exist,
    // or for one classified as having an in-repo caller, reds.
    const cronPaths = readCronPaths();
    expect(cronPaths.length).toBeGreaterThan(0);

    const routeKeys = [...pinned.keys()];
    const classified = cronPaths.map((cronPath) => {
      const routeKey = routeKeyForCronPath(cronPath, routeKeys);
      return { cronPath, verdict: routeKey ? pinned.get(routeKey) : 'no-route-file' };
    });

    expect(classified).toEqual(cronPaths.map((cronPath) => ({ cronPath, verdict: 'keep-external' })));
  });

  it('keeps the paused climb sitemap refresh out of Vercel cron', () => {
    expect(readCronPaths()).not.toContain('/api/internal/refresh-sitemap-climbs');
  });

  it('counts exactly the audited surface', () => {
    // Guards the headline number in issue #1889 itself — a change here means
    // the issue body needs a fresh audit pass, not a quiet reclassification.
    expect(derived.size).toBe(38);
  });
});
