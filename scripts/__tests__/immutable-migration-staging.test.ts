import { describe, expect, it } from 'vite-plus/test';
import config from '../../vite.config';

describe('historical migration staging', () => {
  it('validates shipped migration sources without granting the formatter writes', () => {
    const stage = (config.staged as unknown as Record<string, unknown>)['*.{ts,tsx,js,mjs,cjs}'];
    if (typeof stage !== 'function') throw new Error('Missing staged TypeScript validation');
    const historicalSource = '/checkout/packages/shared/offline-sync/src/db/migrations.ts';
    expect(stage([historicalSource, '/checkout/scripts/check-docs.ts'])).toEqual([
      "vp check --fix '/checkout/scripts/check-docs.ts'",
      `vp check '${historicalSource}'`,
    ]);
    expect(stage(['packages/shared/offline-sync/src/db/migrations.ts'])).toEqual([
      "vp check 'packages/shared/offline-sync/src/db/migrations.ts'",
    ]);
  });
});
