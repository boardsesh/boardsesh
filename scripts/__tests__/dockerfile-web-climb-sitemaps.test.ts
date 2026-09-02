/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Nothing in CI runs the web image, so a text pin is the only in-repo oracle
// that the deployed default publishes climb sitemaps. Same reasoning as
// dockerfile-web-auth-origin.test.ts.
//
// What is being pinned: `CLIMB_SITEMAPS_ENABLED=true` in the RUNNER stage.
// `climbSitemapsEnabled()` reads it at request time, so a builder-stage-only
// declaration would not reach the standalone server — Next's standalone writer
// copies only `.env` and `.env.production`, and the runner stage does not
// inherit the builder's ENV. Losing the line withdraws ~53,000 URLs from
// /sitemap.xml, which is a change nobody would notice from the build log.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile.web'), 'utf8');
const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));

describe('Dockerfile.web climb sitemap publication', () => {
  it('bakes the enabled default into the runner stage', () => {
    // Whole-line match: `toContain('ENV CLIMB_SITEMAPS_ENABLED')` is happily
    // satisfied by `ENV CLIMB_SITEMAPS_ENABLED=false`, and the value is the
    // entire point of the pin.
    expect(runnerStage).toMatch(/^ENV CLIMB_SITEMAPS_ENABLED=true$/m);
  });

  it('documents that a Railway service variable is the kill switch', () => {
    // The gate stays in code precisely so the surface can be withdrawn without
    // a rebuild. If that lever is not written down next to the ENV that hides
    // it, the next operator reaches for a revert instead.
    expect(runnerStage).toMatch(/kill switch/i);
  });
});
