import { describe, expect, it } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY_ROOT = 'app/api/v1/[board_name]/proxy';

const DELETED_PATHS = [`${PROXY_ROOT}/getLogbook`, `${PROXY_ROOT}/saveClimb`, `${PROXY_ROOT}/user-sync`];

// `climb-search-cache` survives: the kept MoonBoard bulk importer imports it
// (components/moonboard-import/moonboard-bulk-import.tsx), and the kept
// /api/internal/climb-search-cache/revalidate route imports the .server half.
// `analytics.server.ts` does not: it was a passthrough to Vercel server
// analytics, which was never enabled on the project, so the one event it
// carried went nowhere. Deleted with the rest of the Vercel telemetry.
const KEPT_PATHS = [
  'app/lib/climb-search-cache.ts',
  'app/lib/climb-search-cache.server.ts',
  'app/api/internal/climb-search-cache/revalidate/route.ts',
  'app/components/moonboard-import/moonboard-bulk-import.tsx',
];

describe('W-25a + W-25b: the Aurora proxies', () => {
  it('deleted the three undocumented proxies', () => {
    for (const path of DELETED_PATHS) expect(existsSync(join(WEB_ROOT, path)), path).toBe(false);
  });

  it('deleted the whole proxy directory, including the two documented proxies that answered 410', () => {
    // Asserting the whole directory is gone (not just the two route.ts files
    // individually) catches a half-delete that leaves a stray __tests__ dir
    // behind, or deletes only one of the two routes.
    expect(existsSync(join(WEB_ROOT, PROXY_ROOT))).toBe(false);
    expect(existsSync(join(WEB_ROOT, 'app/lib/api-deprecation.ts'))).toBe(false);
  });

  it('did not overreach into the climb-search cache', () => {
    for (const path of KEPT_PATHS) expect(existsSync(join(WEB_ROOT, path)), path).toBe(true);
  });
});
