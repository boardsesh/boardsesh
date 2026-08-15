import { describe, expect, it } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY_ROOT = 'app/api/v1/[board_name]/proxy';

const DELETED_PATHS = [`${PROXY_ROOT}/getLogbook`, `${PROXY_ROOT}/saveClimb`, `${PROXY_ROOT}/user-sync`];

// Deprecated, not deleted: W-25b (#4443) removes these after the Sunset date.
const DEPRECATED_PATHS = [`${PROXY_ROOT}/login/route.ts`, `${PROXY_ROOT}/saveAscent/route.ts`];

// `climb-search-cache` survives: the kept MoonBoard bulk importer imports it
// (components/moonboard-import/moonboard-bulk-import.tsx), and the kept
// /api/internal/climb-search-cache/revalidate route imports the .server half.
const KEPT_PATHS = [
  'app/lib/climb-search-cache.ts',
  'app/lib/climb-search-cache.server.ts',
  'app/api/internal/climb-search-cache/revalidate/route.ts',
  'app/components/moonboard-import/moonboard-bulk-import.tsx',
  'app/lib/api-deprecation.ts',
];

describe('W-25a: the Aurora proxies', () => {
  it('deleted the three undocumented proxies', () => {
    for (const path of DELETED_PATHS) expect(existsSync(join(WEB_ROOT, path)), path).toBe(false);
  });

  it('kept the two documented proxies alive to answer 410', () => {
    for (const path of DEPRECATED_PATHS) expect(existsSync(join(WEB_ROOT, path)), path).toBe(true);
  });

  it('did not overreach into the climb-search cache', () => {
    for (const path of KEPT_PATHS) expect(existsSync(join(WEB_ROOT, path)), path).toBe(true);
  });
});
