/**
 * W-21 (#4440): `/settings` survives the reposition, scoped down.
 *
 * A scope-down PR has the same weak oracle as a delete PR — nothing fails when a
 * deleted tree comes back in a merge, and nothing fails when the surviving route
 * quietly acquires a redirect. This file is that oracle:
 *
 *  - the settings component directory and the stranded MoonBoard CSV importer
 *    stay deleted,
 *  - the surfaces the scope-down explicitly keeps stay present — including the
 *    lifted credential card, which two indexable pages render,
 *  - `/settings` keeps no redirect rule in any locale, and
 *  - `/settings` stays in `robots.ts`'s disallow list.
 */
import { describe, expect, it } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DELETED_PATHS = ['app/components/settings', 'app/lib/data-sync/moonboard'];

/**
 * The delete-safety half. A sweep that over-reached into `board-entity/`, the
 * controllers route or the Aurora JSON importer reds here rather than in
 * production: `/aurora-migration` and `/profile/{id}` are indexable and both
 * render the lifted credential card, and the controllers route is the ESP32
 * hardware the epic deliberately keeps on Next.
 */
const KEPT_PATHS = [
  'app/settings/page.tsx',
  'app/settings/settings-page-content.tsx',
  'app/components/account/controllers-section.tsx',
  'app/components/account/set-password-section.tsx',
  'app/api/internal/controllers/route.ts',
  'app/api/internal/profile/route.ts',
  'app/components/board-entity/board-credential-card.tsx',
  'app/components/board-entity/board-credential-card.module.css',
  'app/components/board-entity/board-import-prompt.tsx',
  'app/aurora-migration/aurora-migration-content.tsx',
  'app/profile/[user_id]/components/board-stats-section.tsx',
  'app/lib/data-sync/aurora/json-import-stream.ts',
];

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigWithRedirects = { redirects?: () => Promise<Redirect[]> };

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithRedirects;
const redirects = (await nextConfig.redirects?.()) ?? [];

describe('settings scope-down', () => {
  it('leaves no trace of the dropped settings components', () => {
    const surviving = DELETED_PATHS.filter((path) => existsSync(join(WEB_ROOT, path)));
    expect(surviving).toEqual([]);
  });

  it('keeps every surface the scope-down spared', () => {
    const missing = KEPT_PATHS.filter((path) => !existsSync(join(WEB_ROOT, path)));
    expect(missing).toEqual([]);
  });

  it('gives /settings no redirect in any locale', () => {
    // `/settings` survives the reposition as ESP32 controllers + set-password.
    // A 30x here would strand shipped hardware: the SPA has no equivalent
    // screen, so there is nowhere to send those owners.
    const settingsRules = redirects
      .map((redirect) => redirect.source)
      .filter((source) => source === '/settings' || source.endsWith('/settings'));

    expect(settingsRules).toEqual([]);
  });

  it('keeps /settings disallowed for crawlers', async () => {
    // Duplicates robots.test.ts on purpose: `/settings` sat in the same disallow
    // array as `/feed` and `/you`, which W-19 removed, and it is a utility
    // surface that must stay out of the index.
    const robotsModule = await import('../robots');
    const rules = robotsModule.default().rules;
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const disallowed = ruleList.flatMap((rule) => {
      const disallow = rule?.disallow ?? [];
      return Array.isArray(disallow) ? disallow : [disallow];
    });

    expect(disallowed).toContain('/settings');
  });
});
