import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything between <QueryProvider> and <AuthProvider> in app/_layout.tsx
// mounts BEFORE auth resolves. `AppLoadingSplash` gates AuthProvider's CHILDREN,
// not its siblings, so the "nothing paints first" invariant covers paint but not
// effects — and now that QueryProvider hydrates user-scoped entries at mount, a
// query side effect up here would touch another account's data on a shared
// device (issue #4353).
//
// This guard is the durable half of that promise: it walks the real source, not
// a mock, so a new pre-auth provider or a rename cannot silently leave it
// checking nothing.
const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PRE_AUTH_MODULES = [
  'src/components/analytics/AnalyticsProvider.tsx',
  'src/providers/i18n-provider.tsx',
  'src/providers/query-provider.tsx',
  'src/providers/database-provider.tsx',
  'src/providers/theme-provider.tsx',
  'src/providers/material-theme-provider.tsx',
  'src/providers/dialog-provider.tsx',
  'src/providers/feature-flags-provider.tsx',
  'src/providers/offline-downloads-enabled.ts',
  'src/components/offline-sync-bridge.tsx',
];

// The JSX tags that live between QueryProvider and AuthProvider, mapped to the
// module the guard walks from.
const TAG_TO_MODULE: Record<string, string> = {
  DatabaseProvider: 'src/providers/database-provider.tsx',
  ThemeProvider: 'src/providers/theme-provider.tsx',
  MaterialThemeProvider: 'src/providers/material-theme-provider.tsx',
  DialogProvider: 'src/providers/dialog-provider.tsx',
  FeatureFlagsProvider: 'src/providers/feature-flags-provider.tsx',
  OfflineEngineFlagSync: 'src/components/offline-sync-bridge.tsx',
};

// `src/components/offline-sync-bridge.tsx` is the one documented exemption from
// the file walk, because it holds TWO exports with different mount points.
// `OfflineSyncBridge` legitimately uses useQueryClient/invalidateQueries, but it
// mounts INSIDE AuthProvider and only ever touches ['searchClimbs' |
// 'infiniteSearchClimbs' | 'searchClimbsCount' | 'climb'], none of them
// allowlisted — and its imports (auth-provider, the sync adapter, the
// active-board hook) are what would otherwise drag the whole app into this walk.
// `OfflineEngineFlagSync`, the export that actually mounts pre-auth, gets its
// own targeted assertion below instead, plus its two real dependencies as walk
// seeds.
const BRIDGE_FILE = 'src/components/offline-sync-bridge.tsx';
const WALK_SEEDS = [
  ...PRE_AUTH_MODULES.filter((modulePath) => modulePath !== BRIDGE_FILE),
  'src/lib/offline-engine.ts',
  'src/lib/analytics-offline-engine-state.ts',
];

const FORBIDDEN_QUERY_APIS = [
  'useQuery',
  'useInfiniteQuery',
  'useSuspenseQuery',
  'useQueryClient',
  'getQueryData',
  'setQueryData',
  'fetchQuery',
  'prefetchQuery',
  'ensureQueryData',
  'invalidateQueries',
  'removeQueries',
  'resetQueries',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '/index.ts', '/index.tsx'];

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(MOBILE_ROOT, dirname(fromFile), specifier);
  for (const extension of ['', ...SOURCE_EXTENSIONS]) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      // Skip directories that only exist as directories.
      try {
        readFileSync(candidate, 'utf8');
        return relative(MOBILE_ROOT, candidate);
      } catch {
        // A directory: keep trying the /index candidates.
      }
    }
  }
  return null;
}

function collectTransitiveSources(seeds: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(resolve(MOBILE_ROOT, current), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(current, match[1]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('pre-auth providers never touch the query cache', () => {
  // First: the list is real. A rename would otherwise silently empty the guard.
  it('lists only paths that exist on disk', () => {
    for (const modulePath of PRE_AUTH_MODULES) {
      expect(existsSync(resolve(MOBILE_ROOT, modulePath)), `${modulePath} is missing`).toBe(true);
    }
  });

  // Second: the list still matches what _layout.tsx actually mounts pre-auth.
  it('covers every provider mounted between QueryProvider and AuthProvider', () => {
    const layout = readFileSync(resolve(MOBILE_ROOT, 'app/_layout.tsx'), 'utf8');
    const start = layout.indexOf('<QueryProvider>');
    const end = layout.indexOf('<AuthProvider');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const preAuthJsx = layout
      .slice(start + '<QueryProvider>'.length, end)
      // Drop JSX comments so their prose can't look like a tag.
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const mountedTags = [...preAuthJsx.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(mountedTags.length).toBeGreaterThan(0);

    for (const tag of new Set(mountedTags)) {
      const modulePath = TAG_TO_MODULE[tag];
      expect(modulePath, `<${tag}> mounts pre-auth but this guard does not cover it`).toBeDefined();
      expect(PRE_AUTH_MODULES).toContain(modulePath);
    }
  });

  // T-17
  it('has no query-cache reference anywhere in the pre-auth import graph', () => {
    const sources = collectTransitiveSources(WALK_SEEDS);
    // Sanity: the walk actually reached past the seeds.
    expect(sources.length).toBeGreaterThan(WALK_SEEDS.length);

    const offenders: string[] = [];
    for (const sourcePath of sources) {
      // The persister itself is the thing hydrating the cache; it is reached
      // from query-provider.tsx by design and is not a pre-auth side effect.
      if (sourcePath.startsWith('src/lib/query-persist/')) continue;
      const source = readFileSync(resolve(MOBILE_ROOT, sourcePath), 'utf8');
      for (const api of FORBIDDEN_QUERY_APIS) {
        if (new RegExp(`\\b${api}\\s*[(<]`).test(source)) offenders.push(`${sourcePath} → ${api}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps OfflineEngineFlagSync itself free of query-cache calls', () => {
    const source = readFileSync(resolve(MOBILE_ROOT, BRIDGE_FILE), 'utf8');
    const start = source.indexOf('export function OfflineEngineFlagSync(');
    expect(start).toBeGreaterThan(-1);
    // Up to the next top-level export — the component plus nothing else.
    const nextExport = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, nextExport === -1 ? source.length : nextExport);
    expect(body).toContain('return null;');

    for (const api of FORBIDDEN_QUERY_APIS) {
      expect(new RegExp(`\\b${api}\\s*[(<]`).test(body), `OfflineEngineFlagSync calls ${api}`).toBe(false);
    }
  });
});
